import { randomUUID } from "node:crypto";
import type { ChatDoneEvent, ChatTraceEvent, ClientToServerEvents, ServerToClientEvents } from "@jev-chat/protocol";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import { StaticTokenAuthProvider } from "../auth/static-auth.provider";
import { createTestApp } from "../testing/test-app";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const enabled = !!process.env.TEST_DATABASE_URL;
const ALLOWED_ORIGIN = "http://localhost:5173";

describe.runIf(enabled)("ChatGateway E2E (통합)", () => {
  let url: string;
  let close: () => Promise<void>;
  const clients: Client[] = [];

  beforeAll(async () => {
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card-limit", confidence: 0.9, probabilities: { "faq-card-limit": 0.95, none: 0.05 } } }),
      async (req) => okRelevance(req.chunk.id, 0.1),
    );
    const auth = new StaticTokenAuthProvider({
      alice: { userId: "alice", roles: ["user"] },
      bob: { userId: "bob", roles: ["user"] },
      admin: { userId: "root", roles: ["user", "debug", "admin"] },
    });
    ({ url, close } = await createTestApp({ judge, auth }));
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await close?.();
  });

  function connect(token: string, opts: { protocolVersion?: number; origin?: string; transport?: "websocket" | "polling" } = {}): Promise<Client> {
    const c: Client = io(`${url}/chat`, {
      auth: { token, protocolVersion: opts.protocolVersion ?? 1 },
      transports: [opts.transport ?? "websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { origin: opts.origin ?? ALLOWED_ORIGIN },
    });
    clients.push(c);
    return new Promise((resolve, reject) => {
      c.once("connect", () => resolve(c));
      c.once("connect_error", (e) => reject(e));
    });
  }

  async function startSession(c: Client, sessionId?: string): Promise<string> {
    const r = await c.timeout(3000).emitWithAck("session:start", sessionId ? { sessionId } : {});
    if (!r.ok) throw new Error(r.error.code);
    return r.data.sessionId;
  }

  it("잘못된 토큰 → connect_error UNAUTHORIZED", async () => {
    await expect(connect("nope")).rejects.toMatchObject({ message: "UNAUTHORIZED" });
  });

  it("지원하지 않는 프로토콜 버전 → PROTOCOL_UNSUPPORTED", async () => {
    await expect(connect("alice", { protocolVersion: 99 })).rejects.toMatchObject({ message: "PROTOCOL_UNSUPPORTED" });
  });

  it("[B5] 허용되지 않은 Origin은 websocket·polling 모두 연결 거부(유효 토큰이어도)", async () => {
    await expect(connect("alice", { origin: "http://evil.test", transport: "websocket" })).rejects.toBeTruthy();
    await expect(connect("alice", { origin: "http://evil.test", transport: "polling" })).rejects.toBeTruthy();
    await expect(connect("alice", { transport: "polling" })).resolves.toBeTruthy();
  });

  it("세션 시작 → 전송 → accepted ack → chat:done(faq)", async () => {
    const c = await connect("alice");
    const sessionId = await startSession(c);
    const done = new Promise<ChatDoneEvent>((r) => c.once("chat:done", r));
    const ack = await c.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    expect(ack).toMatchObject({ ok: true, data: { status: "accepted", turnSeq: 1 } });
    expect(await done).toMatchObject({ route: "faq", turnSeq: 1 });
  });

  it("잘못된 페이로드 → INVALID_INPUT ack", async () => {
    const c = await connect("alice");
    const r = await c.timeout(3000).emitWithAck("chat:send", { sessionId: "x", clientMsgId: "y", text: "" } as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("다른 사용자의 세션 접근 → FORBIDDEN, room에도 참여하지 않음", async () => {
    const a = await connect("alice");
    const sessionId = await startSession(a);
    const b = await connect("bob");
    let leaked = false;
    b.on("chat:done", () => (leaked = true));
    expect(await b.timeout(3000).emitWithAck("session:start", { sessionId })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await b.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "q" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const done = new Promise((r) => a.once("chat:done", r));
    await a.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    await done;
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
  });

  it("[I-1] admin은 타인 세션을 session:start로 열람할 수 있지만 chat:send는 FORBIDDEN", async () => {
    const a = await connect("alice");
    const sessionId = await startSession(a);
    const admin = await connect("admin");
    expect(await admin.timeout(3000).emitWithAck("session:start", { sessionId })).toMatchObject({ ok: true, data: { sessionId } });
    expect(await admin.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "q" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("재연결 동기화: 끊긴 동안 완료된 턴을 session:start로 받는다", async () => {
    const c1 = await connect("alice");
    const sessionId = await startSession(c1);
    await c1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    c1.close();
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await connect("alice");
    const again = await c2.timeout(3000).emitWithAck("session:start", { sessionId });
    expect(again.ok && again.data.turns[0]).toMatchObject({ status: "completed", route: "faq" });
  });

  it("[B7] 한 소켓의 중복 재전송은 그 소켓에만 결과를 다시 보낸다", async () => {
    const s1 = await connect("alice");
    const sessionId = await startSession(s1);
    const s2 = await connect("alice");
    await startSession(s2, sessionId);
    let s2Done = 0;
    s2.on("chat:done", () => s2Done++);
    const id = randomUUID();
    const first = new Promise((r) => s1.once("chat:done", r));
    await s1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: id, text: "법인카드 한도 얼마예요?" });
    await first;
    await new Promise((r) => setTimeout(r, 100));
    expect(s2Done).toBe(1); // 원래 완료는 room 전체
    const replay = new Promise((r) => s1.once("chat:done", r));
    expect(await s1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: id, text: "법인카드 한도 얼마예요?" })).toMatchObject({ ok: true, data: { status: "duplicate" } });
    await replay;
    await new Promise((r) => setTimeout(r, 100));
    expect(s2Done).toBe(1); // 재발송은 s2로 가지 않는다
  });

  it("[B8] 같은 세션 room에서 debug 권한 소켓만 trace를 받는다(요청자가 비debug여도)", async () => {
    const owner = await connect("alice"); // 비debug
    const sessionId = await startSession(owner);
    const observer = await connect("admin"); // debug+admin, 같은 세션 관찰
    await startSession(observer, sessionId);
    let ownerTrace = false;
    owner.on("chat:trace", () => (ownerTrace = true));
    const trace = new Promise<ChatTraceEvent>((r) => observer.once("chat:trace", r));
    const done = new Promise((r) => owner.once("chat:done", r));
    await owner.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    await done;
    expect((await trace).trace).toMatchObject({ route: "faq" });
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerTrace).toBe(false);
  });
});
