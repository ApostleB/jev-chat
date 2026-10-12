import { describe, expect, it } from "vitest";
import { deferred, FakeSocket } from "../test/fakes";
import { ChatClient, type ConnState, type SessionState } from "./chat-client";
import type { TurnsAction, UiTurn } from "./turns";

const sid = "00000000-0000-4000-8000-000000000001";
const sid2 = "00000000-0000-4000-8000-000000000002";
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "a")}`;
const tick = () => new Promise((r) => setTimeout(r, 0));
const startOk = (sessionId = sid, extra: object = {}) => ({ ok: true, data: { sessionId, turns: [], hasMore: false, ...extra } });
const sendOk = { ok: true, data: { turnId: "t1", turnSeq: 1, status: "accepted" } };
const doneEvt = { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, turnId: "t1", text: "a", route: "faq", sources: [], traceId: "tr1" };

function setup(resumeSessionId?: string) {
  const sock = new FakeSocket();
  const actions: TurnsAction[] = [];
  const conns: ConnState[] = [];
  const sessions: SessionState[] = [];
  const protocolErrors: string[] = [];
  let n = 0;
  sock.ackResponder = (event) => (event === "session:start" ? startOk() : sendOk);
  const client = new ChatClient({
    url: "http://api.test",
    token: "tok",
    dispatch: (a) => actions.push(a),
    onConn: (s) => conns.push(s),
    onSession: (s) => sessions.push(s),
    onProtocolError: (w) => protocolErrors.push(w),
    ioFactory: () => sock as never,
    newId: () => cid(++n),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
  return { sock, actions, conns, sessions, protocolErrors, client };
}

async function ready(c: ReturnType<typeof setup>) {
  c.client.connect();
  c.sock.serverEmit("connect");
  await tick();
}

describe("ChatClient — 연결·동기화", () => {
  it("[U7] connect() 호출만으로는 동기화하지 않는다 — 서버 handshake(connect 이벤트) 후 session:start", async () => {
    const c = setup();
    c.client.connect();
    expect(c.sock.connectCalls).toBe(1);
    expect(c.sock.emitted).toHaveLength(0);
    c.sock.serverEmit("connect");
    await tick();
    expect(c.sock.emitted).toEqual([{ event: "session:start", payload: {} }]);
  });

  it("[U4] 동기화가 끝나야 ready, 그 전에는 syncing", async () => {
    const c = setup();
    await ready(c);
    expect(c.sessions).toEqual([{ kind: "syncing" }, { kind: "ready", sessionId: sid }]);
    expect(c.actions).toContainEqual({ type: "hydrate", sessionId: sid, turns: [] });
    expect(c.client.sessionId).toBe(sid);
  });

  it("재연결 시 같은 세션으로 다시 동기화", async () => {
    const c = setup();
    await ready(c);
    c.sock.serverEmit("disconnect", "transport close");
    expect(c.sessions.at(-1)).toEqual({ kind: "syncing" });
    c.sock.serverEmit("connect");
    await tick();
    expect(c.sock.emitted.filter((e) => e.event === "session:start").map((e) => e.payload)).toEqual([{}, { sessionId: sid }]);
  });

  it("resumeSessionId가 있으면 그 세션으로 동기화", async () => {
    const c = setup(sid);
    await ready(c);
    expect(c.sock.emitted[0]).toEqual({ event: "session:start", payload: { sessionId: sid } });
  });

  it("[U4] session:start 실패 → error 상태, 전송 불가", async () => {
    const c = setup();
    c.sock.ackResponder = () => ({ ok: false, error: { code: "FORBIDDEN", message: "권한 없음", retryable: false } });
    await ready(c);
    expect(c.sessions.at(-1)).toEqual({ kind: "error", code: "FORBIDDEN" });
    await expect(c.client.send("q")).rejects.toThrow();
  });

  it("[U9] 동기화 결과의 hasMore/nextBeforeTurnSeq를 알린다", async () => {
    const c = setup();
    const histories: unknown[] = [];
    const client = new ChatClient({
      url: "http://api.test", token: "t", dispatch: () => {}, onConn: () => {}, onSession: () => {},
      onHistory: (m, mode) => histories.push({ m, mode }), ioFactory: () => c.sock as never,
    });
    c.sock.ackResponder = () => startOk(sid, { hasMore: true, nextBeforeTurnSeq: 3 });
    client.connect();
    c.sock.serverEmit("connect");
    await tick();
    expect(histories).toEqual([{ m: { hasMore: true, nextBeforeTurnSeq: 3 }, mode: "sync" }]);
  });

  it("connect_error(UNAUTHORIZED) → rejected", () => {
    const c = setup();
    c.client.connect();
    c.sock.serverEmit("connect_error", Object.assign(new Error("UNAUTHORIZED"), { data: { code: "UNAUTHORIZED" } }));
    expect(c.conns.at(-1)).toEqual({ kind: "rejected", code: "UNAUTHORIZED" });
  });
});

describe("ChatClient — 검증 [U1]", () => {
  it("형식이 틀린 session:start 응답은 hydrate하지 않고 error + 프로토콜 오류", async () => {
    const c = setup();
    c.sock.ackResponder = () => ({ ok: true, data: { sessionId: 123, turns: null } });
    await ready(c);
    expect(c.actions.some((a) => a.type === "hydrate")).toBe(false);
    expect(c.sessions.at(-1)).toEqual({ kind: "error", code: "INTERNAL" });
    expect(c.protocolErrors).toContain("session:start");
  });

  it("형식이 틀린 서버 이벤트는 무시하고 프로토콜 오류로 알린다", async () => {
    const c = setup();
    await ready(c);
    const before = c.actions.length;
    c.sock.serverEmit("chat:done", null);
    c.sock.serverEmit("chat:done", { ...doneEvt, turnSeq: -1 });
    c.sock.serverEmit("chat:done", { ...doneEvt, sessionId: 123 });
    c.sock.serverEmit("chat:done", { ...doneEvt, route: undefined });
    c.sock.serverEmit("chat:status", { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, stage: "weird" });
    c.sock.serverEmit("chat:error", { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, code: "NOPE", message: "x", retryable: true });
    c.sock.serverEmit("chat:trace", { sessionId: sid, traceId: 1 });
    expect(c.actions.length).toBe(before);
    expect(c.protocolErrors.filter((w) => w.startsWith("chat:"))).toHaveLength(7);
  });

  it("정상 이벤트는 dispatch, trace는 서버가 준 원 sessionId를 그대로 쓴다", async () => {
    const c = setup();
    await ready(c);
    c.sock.serverEmit("chat:done", doneEvt);
    c.sock.serverEmit("chat:trace", { sessionId: sid, traceId: "tr1", trace: { route: "faq" } });
    expect(c.actions.slice(-2)).toEqual([
      { type: "done", e: doneEvt },
      { type: "trace", e: { sessionId: sid, traceId: "tr1", trace: { route: "faq" } } },
    ]);
  });

  it("[U3] sessionId가 없는 trace는 프로토콜 오류로 거부", async () => {
    const c = setup();
    await ready(c);
    const before = c.actions.length;
    c.sock.serverEmit("chat:trace", { traceId: "tr1", trace: {} });
    expect(c.actions.length).toBe(before);
  });
});

describe("ChatClient — 전송 [U2]", () => {
  it("localSend → ack, 모두 sessionId 포함", async () => {
    const c = setup();
    await ready(c);
    await c.client.send("법인카드 한도");
    const sends = c.actions.filter((a) => a.type === "localSend" || a.type === "ack");
    expect(sends).toEqual([
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "법인카드 한도" },
      { type: "ack", sessionId: sid, clientMsgId: cid(1), turnId: "t1", turnSeq: 1 },
    ]);
  });

  it("ok:false → 확정 실패(uncertain=false), 다시 보내기는 새 ID + retryOfTurnSeq", async () => {
    const c = setup();
    await ready(c);
    c.sock.ackResponder = () => ({ ok: false, error: { code: "QUEUE_FULL", message: "많음", retryable: true, retryAfterMs: 2000 } });
    await c.client.send("q");
    expect(c.actions.at(-1)).toMatchObject({ type: "ackFailed", error: { code: "QUEUE_FULL", uncertain: false } });
    c.sock.ackResponder = () => sendOk;
    const turn = { clientMsgId: cid(1), userText: "q", turnSeq: 3, sendError: { code: "QUEUE_FULL", message: "", retryable: true, uncertain: false } } as UiTurn;
    await c.client.retry(turn);
    expect(c.sock.emitted.at(-1)?.payload).toMatchObject({ clientMsgId: cid(2), retryOfTurnSeq: 3 });
  });

  it("ack timeout(예외) → 미확정, 다시 보내기는 같은 clientMsgId·같은 text, retryOfTurnSeq 없음", async () => {
    const c = setup();
    await ready(c);
    c.sock.ackResponder = () => {
      throw new Error("operation has timed out");
    };
    await c.client.send("q");
    expect(c.actions.at(-1)).toMatchObject({ type: "ackFailed", clientMsgId: cid(1), error: { uncertain: true, retryable: true } });
    c.sock.ackResponder = () => ({ ok: true, data: { turnId: "t1", turnSeq: 1, status: "duplicate" } });
    const turn = { clientMsgId: cid(1), userText: "q", turnSeq: 0, sendError: { code: "INTERNAL", message: "", retryable: true, uncertain: true } } as UiTurn;
    await c.client.retry(turn);
    const payload = c.sock.emitted.at(-1)?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ clientMsgId: cid(1), text: "q" });
    expect(payload.retryOfTurnSeq).toBeUndefined();
  });

  it("형식이 틀린 send ack도 미확정으로 처리", async () => {
    const c = setup();
    await ready(c);
    c.sock.ackResponder = () => ({ ok: true, data: { turnId: 1 } });
    await c.client.send("q");
    expect(c.actions.at(-1)).toMatchObject({ type: "ackFailed", error: { uncertain: true } });
    expect(c.protocolErrors).toContain("chat:send");
  });

  it("빈 메시지·1000자 초과는 보내지 않는다", async () => {
    const c = setup();
    await ready(c);
    const before = c.sock.emitted.length;
    await expect(c.client.send("   ")).rejects.toThrow();
    await expect(c.client.send("가".repeat(1001))).rejects.toThrow();
    expect(c.sock.emitted.length).toBe(before);
  });
});

describe("ChatClient — 세대 [U3]", () => {
  it("새 세션으로 바뀐 뒤 도착한 이전 세션의 ack는 dispatch하지 않는다", async () => {
    const c = setup();
    await ready(c);
    const pendingAck = deferred<unknown>();
    c.sock.ackResponder = (event) => (event === "chat:send" ? pendingAck.promise : startOk(sid2));
    const sending = c.client.send("q");
    await tick();
    await c.client.newSession();
    pendingAck.resolve(sendOk);
    await sending;
    expect(c.actions.filter((a) => a.type === "ack")).toEqual([]);
    expect(c.client.sessionId).toBe(sid2);
  });

  it("늦게 도착한 이전 session:start 응답은 무시", async () => {
    const c = setup();
    const first = deferred<unknown>();
    let call = 0;
    c.sock.ackResponder = () => (++call === 1 ? first.promise : startOk(sid2));
    c.client.connect();
    c.sock.serverEmit("connect");
    await tick();
    await c.client.newSession();
    first.resolve(startOk(sid));
    await tick();
    expect(c.actions.filter((a) => a.type === "hydrate").map((a) => (a as { sessionId: string }).sessionId)).toEqual([sid2]);
    expect(c.client.sessionId).toBe(sid2);
  });

  it("close 후에는 listener가 모두 해제되고 이벤트를 무시", async () => {
    const c = setup();
    await ready(c);
    c.client.close();
    expect(c.sock.listenerCount()).toBe(0);
    const before = c.actions.length;
    c.sock.serverEmit("chat:done", doneEvt);
    expect(c.actions.length).toBe(before);
  });
});
