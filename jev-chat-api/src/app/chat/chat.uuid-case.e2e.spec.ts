import { randomUUID } from "node:crypto";
import type { ChatDoneEvent, ClientToServerEvents, ServerToClientEvents } from "@jev-chat/protocol";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import { StaticTokenAuthProvider } from "../auth/static-auth.provider";
import { createTestApp } from "../testing/test-app";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const enabled = !!process.env.TEST_DATABASE_URL;

/** [Q1] 같은 세션 UUID의 대/소문자 표기를 섞어 보내도 실제 DB·소켓에서 하나의 세션으로 처리된다 */
describe.runIf(enabled)("UUID 표기 혼합 E2E (실제 MariaDB)", () => {
  let url: string;
  let close: () => Promise<void>;
  const clients: Client[] = [];
  let running = 0;
  let maxRunning = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const judge = new FakeJudge(
    async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running--;
      return okTurn({ regulation: 1 });
    },
    async (req) => okRelevance(req.chunk.id, 0.9),
  );

  beforeAll(async () => {
    const auth = new StaticTokenAuthProvider({
      carol: { userId: "carol", roles: ["user"] },
      admin: { userId: "root", roles: ["user", "debug", "admin"] },
    });
    ({ url, close } = await createTestApp({ judge, auth }));
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await close?.();
  });

  async function connect(token: string): Promise<Client> {
    const c: Client = io(`${url}/chat`, { auth: { token, protocolVersion: 1 }, transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: { origin: "http://localhost:5173" } });
    clients.push(c);
    await new Promise<void>((resolve, reject) => {
      c.once("connect", () => resolve());
      c.once("connect_error", reject);
    });
    return c;
  }

  it("6번째 QUEUE_FULL, 엔진 동시 실행 1, 직전 문맥 반영, 소문자 room 관찰자가 대문자 턴 이벤트 수신, clientMsgId 표기 차이는 duplicate", async () => {
    const owner = await connect("carol");
    const started = await owner.timeout(3000).emitWithAck("session:start", {});
    if (!started.ok) throw new Error("start");
    const sid = started.data.sessionId;
    expect(sid).toBe(sid.toLowerCase());

    const observer = await connect("admin");
    expect((await observer.timeout(3000).emitWithAck("session:start", { sessionId: sid.toLowerCase() })).ok).toBe(true); // 소문자로 room 참여
    const observed: ChatDoneEvent[] = [];
    observer.on("chat:done", (e) => observed.push(e));

    const ids = Array.from({ length: 6 }, () => randomUUID());
    const acks = [];
    for (let i = 0; i < 6; i++) {
      const sessionId = (i % 2 === 0 ? sid.toUpperCase() : sid.toLowerCase()) as typeof sid;
      const clientMsgId = (i % 3 === 0 ? ids[i]!.toUpperCase() : ids[i]!) as (typeof ids)[number];
      acks.push(await owner.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId, text: "법인카드 한도" }));
    }
    expect(acks.slice(0, 5).map((a) => a.ok)).toEqual([true, true, true, true, true]);
    expect(acks[5]).toMatchObject({ ok: false, error: { code: "QUEUE_FULL" } }); // (a)

    release();
    await expect.poll(() => observed.length, { timeout: 5000 }).toBe(5); // (d) 대문자로 보낸 턴 포함 5건 모두 수신
    expect(new Set(observed.map((e) => e.sessionId))).toEqual(new Set([sid]));
    expect(maxRunning).toBe(1); // (b)
    expect(judge.turnCalls.at(-1)?.recentTurns.length).toBeGreaterThan(0); // (c) 직전 완료 턴 문맥
    expect(judge.turnCalls[1]?.recentTurns.map((t) => t.role)).toEqual(["user", "assistant"]);

    const dup = await owner.timeout(3000).emitWithAck("chat:send", { sessionId: sid.toUpperCase() as typeof sid, clientMsgId: ids[0]!.toUpperCase() as (typeof ids)[number], text: "법인카드 한도" });
    expect(dup).toMatchObject({ ok: true, data: { status: "duplicate", turnSeq: 1 } });
  }, 15_000);
});
