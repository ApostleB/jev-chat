import { describe, expect, it } from "vitest";
import { FakeSocket, deferred } from "../test/fakes";
import { ChatClient } from "./chat-client";
import { initialTurns, turnsReducer, type TurnsAction, type TurnsState } from "./turns";

const sid = "00000000-0000-4000-8000-000000000001";
const sid2 = "00000000-0000-4000-8000-000000000002";
const sid3 = "00000000-0000-4000-8000-000000000003";
const cid = "00000000-0000-4000-8000-00000000aaaa";
const tick = () => new Promise((r) => setTimeout(r, 0));
const processingTurn = { turnId: "t1", turnSeq: 1, clientMsgId: cid, userText: "질문", status: "processing" };
const done = (sessionId = sid) => ({ sessionId, clientMsgId: cid, turnSeq: 1, turnId: "t1", text: "답변", route: "faq", sources: [], traceId: "tr1" });
const errEvt = (sessionId = sid) => ({ sessionId, clientMsgId: cid, turnSeq: 1, code: "INTERNAL", message: "x", retryable: true });
const traceEvt = (sessionId = sid) => ({ sessionId, traceId: "tr1", trace: { a: 1 } });

function setup() {
  const sock = new FakeSocket();
  const startAck = deferred<unknown>();
  let state: TurnsState = initialTurns;
  const dispatch = (a: TurnsAction) => {
    state = turnsReducer(state, a);
  };
  sock.ackResponder = () => startAck.promise;
  const client = new ChatClient({
    url: "http://api.test",
    token: "tok",
    dispatch,
    onConn: () => {},
    onSession: () => {},
    resumeSessionId: sid,
    ioFactory: () => sock as never,
  });
  client.connect();
  sock.serverEmit("connect");
  return { sock, startAck, client, get: () => state };
}
const ok = (sessionId: string, turns: object[]) => ({ ok: true, data: { sessionId, turns, hasMore: false } });

describe("F1 — resume ack 전에 도착한 이벤트", () => {
  it("done이 먼저 오고 processing 이력이 나중에 와도 completed·답변 유지", async () => {
    const c = setup();
    await tick();
    c.sock.serverEmit("chat:done", done());
    c.sock.serverEmit("chat:trace", traceEvt());
    c.startAck.resolve(ok(sid, [processingTurn]));
    await tick();
    const t = Object.values(c.get().byClientId)[0];
    expect(t).toMatchObject({ status: "completed", assistantText: "답변", userText: "질문" });
    expect(c.get().traces["tr1"]).toEqual({ a: 1 });
  });

  it("error가 먼저 와도 failed 유지", async () => {
    const c = setup();
    await tick();
    c.sock.serverEmit("chat:error", errEvt());
    c.startAck.resolve(ok(sid, [processingTurn]));
    await tick();
    expect(Object.values(c.get().byClientId)[0]).toMatchObject({ status: "failed", userText: "질문" });
  });

  it("다른 세션의 이벤트는 배제", async () => {
    const c = setup();
    await tick();
    c.sock.serverEmit("chat:done", done(sid2));
    c.sock.serverEmit("chat:trace", traceEvt(sid2));
    c.startAck.resolve(ok(sid, [processingTurn]));
    await tick();
    expect(Object.values(c.get().byClientId)[0]).toMatchObject({ status: "processing" });
    expect(c.get().traces).toEqual({});
  });

  it("resume NOT_FOUND 후 새 세션 화면에 이전 이벤트가 남지 않는다", async () => {
    const c = setup();
    await tick();
    c.sock.serverEmit("chat:done", done());
    c.sock.serverEmit("chat:trace", traceEvt());
    expect(Object.keys(c.get().byClientId)).toHaveLength(1);
    c.sock.ackResponder = (_e, p) =>
      (p as { sessionId?: string }).sessionId ? { ok: false, error: { code: "NOT_FOUND", message: "x", retryable: false } } : ok(sid3, []);
    c.startAck.resolve({ ok: false, error: { code: "NOT_FOUND", message: "x", retryable: false } });
    await tick();
    await tick();
    expect(c.get().sessionId).toBe(sid3);
    expect(c.get().byClientId).toEqual({});
    expect(c.get().traces).toEqual({});
  });
});
