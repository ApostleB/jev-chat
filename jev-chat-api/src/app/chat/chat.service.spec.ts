import { randomUUID } from "node:crypto";
import type { ChatDoneEvent, ChatErrorEvent, ChatStatusEvent, ChatTraceEvent } from "@jev-chat/protocol";
import { ChatDoneEventSchema, ChatErrorEventSchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Judge, type Policy } from "../../core";
import { chunkFixture, faqFixture } from "../../core/testing/fixtures";
import { FakeJudge, makeSnapshot, okRelevance, okTurn } from "../../core/testing/fakes";
import { ChatService } from "./chat.service";
import type { ChatEvents } from "./chat-events";
import { InMemoryTurnStore } from "./in-memory-turn-store";
import { SessionQueue } from "./session-queue";
import { SlidingWindowRateLimiter } from "./rate-limiter";

const chunks = [chunkFixture({ id: "card-1", title: "법인카드 규정", section: "한도", text: "법인카드 1회 사용 한도는 50만 원이다" })];
const faqs = [faqFixture({ id: "faq-card", summary: "법인카드 1회 한도", variants: ["법인카드 한도 얼마예요"], answer: "1회 50만 원입니다.", sourceChunkId: "card-1" })];
type TestPrincipal = { userId: string; roles: Array<"user" | "debug" | "admin"> };
const alice: TestPrincipal = { userId: "alice", roles: ["user"] };
const bob: TestPrincipal = { userId: "bob", roles: ["user"] };

class Recorder implements ChatEvents {
  log: string[] = [];
  statuses: ChatStatusEvent[] = [];
  dones: ChatDoneEvent[] = [];
  errors: ChatErrorEvent[] = [];
  traces: ChatTraceEvent[] = [];
  status(e: ChatStatusEvent) { this.statuses.push(e); this.log.push(`status:${e.stage}`); }
  done(e: ChatDoneEvent) { this.dones.push(ChatDoneEventSchema.parse(e)); this.log.push("done"); }
  error(e: ChatErrorEvent) { this.errors.push(ChatErrorEventSchema.parse(e)); this.log.push(`error:${e.code}`); }
  trace(_s: string, e: ChatTraceEvent) { this.traces.push(e); this.log.push("trace"); }
}

const faqJudge = () =>
  new FakeJudge(
    async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.95, none: 0.05 } } }),
    async (req) => okRelevance(req.chunk.id, 0.1),
  );

function setup(opts: { judge?: Judge; capacity?: number; sendLimit?: number; policy?: Policy } = {}) {
  const store = new InMemoryTurnStore();
  const snap = makeSnapshot({ chunks, faqs, ...(opts.policy ? { policy: opts.policy } : {}) });
  const svc = new ChatService({
    store,
    snapshots: { current: () => snap },
    judge: opts.judge ?? faqJudge(),
    queue: new SessionQueue({ capacity: opts.capacity ?? 5 }),
    sendLimiter: new SlidingWindowRateLimiter(opts.sendLimit ?? 10, 60_000),
    sessionLimiter: new SlidingWindowRateLimiter(20, 60_000),
    replayLimiter: new SlidingWindowRateLimiter(30, 60_000),
    log: () => {},
  });
  return { store, svc };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const noJoin = async () => {};

async function session(svc: ChatService, p: TestPrincipal = alice) {
  const r = await svc.startSession(p, {}, "front-test", noJoin);
  if (!r.ok) throw new Error("session");
  return r.data.sessionId;
}

const send = (svc: ChatService, p: TestPrincipal, sessionId: string, text: string, ev = new Recorder(), reply = new Recorder(), clientMsgId = randomUUID()) =>
  svc.send(p, { sessionId, clientMsgId, text }, ev, reply);

describe("ChatService", () => {
  it("정상 흐름: status(queued) → accepted ack → status → done(저장 후) → trace(항상 포트로)", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const ev = new Recorder();
    const ack = await send(svc, alice, sid, "법인카드 한도 얼마예요", ev);
    ev.log.push("ack");
    expect(ack).toMatchObject({ ok: true, data: { status: "accepted", turnSeq: 1 } });
    await settle();
    expect(ev.log).toEqual(["status:queued", "ack", "status:judging", "status:answering", "done", "trace"]);
    expect(ev.dones[0]).toMatchObject({ route: "faq", turnSeq: 1 });
    expect(store.turns[0]?.status).toBe("completed");
  });

  it("다른 사용자의 세션 → FORBIDDEN, 없는 세션 → NOT_FOUND", async () => {
    const { svc } = setup();
    const sid = await session(svc, alice);
    expect(await send(svc, bob, sid, "q")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await send(svc, alice, randomUUID(), "q")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("[I-1] admin: 타인 세션 chat:send는 FORBIDDEN, session:start(열람)는 허용, 본인 세션 발송은 허용", async () => {
    const { svc } = setup();
    const admin: TestPrincipal = { userId: "root", roles: ["user", "admin"] };
    const sid = await session(svc, alice);
    expect(await send(svc, admin, sid, "q")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const started = await svc.startSession(admin, { sessionId: sid }, "front-test", noJoin);
    expect(started).toMatchObject({ ok: true, data: { sessionId: sid } });
    const own = await session(svc, admin);
    expect(await send(svc, admin, own, "q")).toMatchObject({ ok: true });
  });

  it("[B1] 저장소 조회 예외 → INTERNAL ack(예외를 던지지 않음), 슬롯 누수 없음", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    store.throwOn.add("findSession");
    expect(await send(svc, alice, sid, "q")).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await svc.startSession(alice, { sessionId: sid }, "front-test", noJoin)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    store.throwOn.clear();
    expect((await send(svc, alice, sid, "법인카드 한도 얼마예요")).ok).toBe(true);
    await settle();
    expect(svc.inflightCount()).toBe(0);
  });

  it("[B7] 멱등 재전송: duplicate ack, 결과는 요청 소켓(reply)에만 재발송", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await send(svc, alice, sid, "법인카드 한도 얼마예요", new Recorder(), new Recorder(), id);
    await settle();
    const room = new Recorder();
    const reply = new Recorder();
    expect(await send(svc, alice, sid, "법인카드 한도 얼마예요", room, reply, id)).toMatchObject({ ok: true, data: { status: "duplicate", turnSeq: 1 } });
    await settle();
    expect(reply.dones).toHaveLength(1);
    expect(room.dones).toHaveLength(0);
    expect(store.turns).toHaveLength(1);
  });

  it("멱등: 같은 clientMsgId + 다른 text → INVALID_INPUT", async () => {
    const { svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await send(svc, alice, sid, "a", new Recorder(), new Recorder(), id);
    expect(await send(svc, alice, sid, "b", new Recorder(), new Recorder(), id)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("stale processing 재전송 → failTurn 성공 시에만 RESTARTED", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await store.reserveTurn({ sessionId: sid, clientMsgId: id, userText: "q" });
    const reply = new Recorder();
    await send(svc, alice, sid, "q", new Recorder(), reply, id);
    await settle();
    expect(reply.errors[0]).toMatchObject({ code: "RESTARTED", retryable: true });
  });

  it("[B2] stale 조회 후 그 사이 완료됐다면 RESTARTED가 아니라 실제 결과를 보낸다", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    const row = await store.reserveTurn({ sessionId: sid, clientMsgId: id, userText: "q" });
    store.beforeFail = () => Object.assign(row, { status: "completed", assistantText: "이미 완료", route: "faq", sources: [], traceId: "tr-x" });
    const reply = new Recorder();
    await send(svc, alice, sid, "q", new Recorder(), reply, id);
    await settle();
    expect(reply.errors).toHaveLength(0);
    expect(reply.dones[0]).toMatchObject({ text: "이미 완료", traceId: "tr-x" });
  });

  it("세션 대기+처리 capacity 초과 → QUEUE_FULL, DB 기록 없음, 슬롯 반환 후 다시 가능", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const { store, svc } = setup({ judge, capacity: 2 });
    const sid = await session(svc);
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
    expect(await send(svc, alice, sid, "법인카드")).toMatchObject({ ok: false, error: { code: "QUEUE_FULL", retryAfterMs: 2000 } });
    expect(store.turns).toHaveLength(2);
    release();
    await settle();
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
  });

  it("레이트 리밋 → RATE_LIMITED + retryAfterMs", async () => {
    const { svc } = setup({ sendLimit: 1 });
    const sid = await session(svc);
    await send(svc, alice, sid, "a");
    const r = await send(svc, alice, sid, "b");
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!r.ok) expect(r.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("세션 내 순차 처리: 두 번째 턴은 첫 턴 완료 후 그 문맥을 본다", async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.9));
    const { svc } = setup({ judge });
    const sid = await session(svc);
    await send(svc, alice, sid, "법인카드 한도");
    await send(svc, alice, sid, "그럼 회식비는요?");
    await settle();
    expect(judge.turnCalls[1]?.recentTurns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("[B4] 앞 작업이 끝나지 않아도 queueMs가 지나면 즉시 QUEUE_TIMEOUT, 슬롯 회수, 나중에도 실행 안 함", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const policy: Policy = { ...DEFAULT_POLICY, deadlines: { ...DEFAULT_POLICY.deadlines, queueMs: 50 } };
    const { store, svc } = setup({ judge, policy, capacity: 2 });
    const sid = await session(svc);
    await send(svc, alice, sid, "법인카드 첫째");
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드 둘째", ev);
    await settle(120); // 앞 작업은 여전히 대기 중
    expect(ev.errors[0]).toMatchObject({ code: "QUEUE_TIMEOUT", retryable: true });
    expect(store.turns[1]?.status).toBe("failed");
    expect((await send(svc, alice, sid, "법인카드 셋째")).ok).toBe(true); // 슬롯 회수(capacity 2)
    release();
    await settle(80);
    expect(judge.turnCalls.map((c) => c.message)).not.toContain("법인카드 둘째");
  });

  it("엔진 예외 → failed(INTERNAL) + chat:error, 큐는 계속 동작", async () => {
    const judge: Judge = { judgeTurn: async () => { throw new Error("bug"); }, judgeRelevance: async () => { throw new Error("bug"); } };
    const { store, svc } = setup({ judge });
    const sid = await session(svc);
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드", ev);
    await settle();
    expect(ev.errors[0]).toMatchObject({ code: "INTERNAL", retryable: false });
    expect(store.turns[0]?.status).toBe("failed");
    expect(svc.inflightCount()).toBe(0);
  });

  it("[M-2] 멱등 재발송은 duplicate ack 뒤에 보내고, reply가 던져도 uncaughtException 없이 로그만 남긴다", async () => {
    const logs: string[] = [];
    const store = new InMemoryTurnStore();
    const snap = makeSnapshot({ chunks, faqs });
    const svc = new ChatService({
      store, snapshots: { current: () => snap }, judge: faqJudge(), queue: new SessionQueue({ capacity: 5 }),
      sendLimiter: new SlidingWindowRateLimiter(10, 60_000), sessionLimiter: new SlidingWindowRateLimiter(20, 60_000), replayLimiter: new SlidingWindowRateLimiter(30, 60_000),
      log: (where) => logs.push(where),
    });
    const sid = await session(svc);
    const id = randomUUID();
    await send(svc, alice, sid, "법인카드 한도 얼마예요", new Recorder(), new Recorder(), id);
    await settle();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const order: string[] = [];
      const reply = { done: () => { order.push("replay"); throw new Error("socket gone"); }, error: () => {} };
      const ack = await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "법인카드 한도 얼마예요" }, new Recorder(), reply);
      order.push("ack");
      await settle();
      expect(ack).toMatchObject({ ok: true, data: { status: "duplicate" } });
      expect(order).toEqual(["ack", "replay"]);
      expect(uncaught).toEqual([]);
      expect(logs).toContain("replay");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("[M-1] failTurn이 false(다른 경로가 이미 종료)면 저장된 최신 상태대로 통지한다: completed→done, failed→error, processing→무통지", async () => {
    const judge = new FakeJudge(async () => { throw new Error("bug"); }, async () => { throw new Error("bug"); });
    for (const [finalState, expected] of [["completed", "done"], ["failed", "error:RESTARTED"], ["processing", null]] as const) {
      const { store, svc } = setup({ judge });
      const sid = await session(svc);
      store.beforeFail = () => {
        const t = store.turns[0]!;
        if (finalState === "completed") Object.assign(t, { status: "completed", assistantText: "다른 경로 완료", route: "faq", sources: [], traceId: "tr-1" });
        if (finalState === "failed") Object.assign(t, { status: "failed", errorCode: "RESTARTED", errorRetryable: true });
      };
      if (finalState === "processing") store.failReturnsFalse = true;
      const ev = new Recorder();
      await send(svc, alice, sid, "법인카드", ev);
      await settle();
      expect(ev.log.filter((l) => l === "done" || l.startsWith("error:")), finalState).toEqual(expected ? [expected] : []);
    }
  });

  it("[M-1] 대기 만료(expire)에서 failTurn이 false여도 같은 규칙으로 통지한다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const policy: Policy = { ...DEFAULT_POLICY, deadlines: { ...DEFAULT_POLICY.deadlines, queueMs: 50 } };
    const { store, svc } = setup({ judge, policy, capacity: 2 });
    const sid = await session(svc);
    await send(svc, alice, sid, "법인카드 첫째");
    store.beforeFail = () => Object.assign(store.turns[1]!, { status: "failed", errorCode: "RESTARTED", errorRetryable: true });
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드 둘째", ev);
    await settle(120);
    expect(ev.errors[0]).toMatchObject({ code: "RESTARTED" });
    release();
    await settle(80);
  });

  it("[M-4] 판단이 abort를 무시하고 pending이어도 엔진 기한 후 오류 응답(completed, route=error)으로 확정하고 슬롯·세션 체인을 놓는다. 늦은 결과는 저장·발송하지 않는다", async () => {
    let lateResolve!: () => void;
    const hang = new Promise<void>((r) => (lateResolve = r));
    let calls = 0;
    const judge = new FakeJudge(
      async () => { if (calls++ === 0) { await hang; } return okTurn({ regulation: 1 }, { faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.95, none: 0.05 } } }); },
      async (req) => okRelevance(req.chunk.id, 0.1),
    );
    const policy: Policy = { ...DEFAULT_POLICY, deadlines: { ...DEFAULT_POLICY.deadlines, engineMs: 50 } };
    const { store, svc } = setup({ judge, policy, capacity: 2 });
    const sid = await session(svc);
    const ev1 = new Recorder();
    await send(svc, alice, sid, "법인카드 첫째", ev1);
    const ev2 = new Recorder();
    await send(svc, alice, sid, "법인카드 둘째", ev2);
    await settle(400);
    expect(ev1.dones[0]).toMatchObject({ route: "error", error: { code: "JEV_UNAVAILABLE", retryable: true } });
    expect(store.turns[0]).toMatchObject({ status: "completed", route: "error" });
    expect(store.turns[1]?.status).toBe("completed"); // 체인이 풀려 다음 턴이 진행됨
    expect(ev2.dones[0]).toMatchObject({ route: "faq" });
    expect(svc.inflightCount()).toBe(0);
    lateResolve(); // 늦게 끝난 첫 판단 결과
    await settle(50);
    expect(ev1.dones).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({ status: "completed", route: "error" });
  });

  it("저장 실패 → done을 보내지 않고 chat:error(INTERNAL)", async () => {
    const { store, svc } = setup();
    store.failComplete = true;
    const sid = await session(svc);
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드 한도 얼마예요", ev);
    await settle();
    expect(ev.dones).toHaveLength(0);
    expect(ev.errors[0]).toMatchObject({ code: "INTERNAL" });
  });

  it("Jev 장애(route=error)는 completed + done(error 포함)", async () => {
    const judge = new FakeJudge(
      async () => ({ ok: false, errorKind: "provider", message: "529", audit: { call: "turn", status: "failed", attempts: 2, latencyMs: 1 } }),
      async (req) => okRelevance(req.chunk.id, 0),
    );
    const { svc } = setup({ judge });
    const sid = await session(svc);
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드", ev);
    await settle();
    expect(ev.dones[0]).toMatchObject({ route: "error", error: { code: "JEV_UNAVAILABLE", retryable: true } });
  });

  it("[B3] startSession: join이 이력 조회보다 먼저, 권한 없으면 join 안 함, 최신 50턴 + hasMore", async () => {
    const { store, svc } = setup();
    const created = await svc.startSession(alice, {}, "front-test", noJoin);
    expect(created).toMatchObject({ ok: true, data: { turns: [], hasMore: false } });
    const sid = created.ok ? created.data.sessionId : "";
    for (let i = 0; i < 52; i++) await store.reserveTurn({ sessionId: sid, clientMsgId: randomUUID(), userText: `q${i}` });
    store.calls.length = 0;
    const r = await svc.startSession(alice, { sessionId: sid }, "front-test", async () => void store.calls.push("join"));
    expect(store.calls.indexOf("join")).toBeLessThan(store.calls.indexOf("listTurns"));
    expect(r.ok && r.data.turns.length).toBe(50);
    expect(r.ok && r.data.hasMore).toBe(true);
    expect(r.ok && r.data.nextBeforeTurnSeq).toBe(3);
    let joined = false;
    expect(await svc.startSession(bob, { sessionId: sid }, "front-test", async () => void (joined = true))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(joined).toBe(false);
  });
});
