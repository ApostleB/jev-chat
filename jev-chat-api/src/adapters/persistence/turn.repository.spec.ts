import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../core";
import { resetTestDb, testPrisma } from "./prisma";
import { TurnRepository } from "./turn.repository";

const prisma = testPrisma();
/** 길이 초과로 실패를 주입하는 테스트의 전제: strict SQL mode가 아니면 값이 잘려 저장되어 원인이 가려진다. */
async function expectStrictSqlMode(): Promise<void> {
  const rows = await prisma!.$queryRaw<{ m: string }[]>`SELECT @@SESSION.sql_mode AS m`;
  expect(rows[0]?.m, "테스트 DB의 sql_mode는 STRICT_TRANS_TABLES 또는 STRICT_ALL_TABLES여야 한다").toMatch(/STRICT_(TRANS|ALL)_TABLES/);
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function result(text: string, route: EngineResult["route"] = "faq"): EngineResult {
  return {
    route,
    text,
    sources: [{ chunkId: "c1", versionId: "v1", contentHash: "h", title: "법인카드 규정", section: "한도" }],
    trace: {
      knowledgeVersionId: "v1", templateVersion: "v1", model: "jev-1.13.0", policy: {} as never, contextTurnSeqs: [],
      intent: "regulation", intentProbs: null, inScope: 0.95, ambiguity: 0.1, faqChoice: "f", faqProb: 0.9, faqConfidence: 0.8,
      route, retrieval: { faqQuery: "q", chunkQueries: ["q"], faqCandidateIds: [], chunkCandidateIds: [] }, candidates: [],
      bStatus: "skipped", jevCalls: [], latencyMs: { retrieval: 1, turn: 1, relevance: null, total: 2 }, totalInputTokens: 123, errorCode: null,
    },
  };
}

describe.runIf(prisma)("TurnRepository (통합)", () => {
  const repo = new TurnRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("reserveTurn은 turn_seq를 1부터 증가시킨다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t1 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "a" });
    const t2 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(2), userText: "b", retryOfTurnSeq: 1 });
    expect([t1.turnSeq, t2.turnSeq]).toEqual([1, 2]);
    expect(t1.status).toBe("processing");
  });

  it("[R3] 같은 clientMsgId로 다시 예약하면 실패하고 next_turn_seq는 증가하지 않는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "a" });
    const counter = async () => (await prisma!.chatSession.findUnique({ where: { id: s.id } }))?.nextTurnSeq;
    const before = await counter();
    await expect(repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "중복" })).rejects.toThrow();
    expect(await counter()).toBe(before);
    const next = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(2), userText: "b" });
    expect(next.turnSeq).toBe(2);
  });

  it("동시 reserveTurn도 turn_seq가 겹치지 않는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const turns = await Promise.all([1, 2, 3, 4, 5].map((n) => repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: "x" })));
    expect(turns.map((t) => t.turnSeq).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("completeTurn: 턴 갱신 + trace 저장, 두 번째 완료는 null", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "한도?" });
    const done = await repo.completeTurn(t.id, result("50만 원입니다."));
    expect(done?.traceId).toBeTruthy();
    expect(await repo.completeTurn(t.id, result("중복"))).toBeNull();
    const row = await repo.findTurnByClientMsgId(s.id, uuid(1));
    expect(row).toMatchObject({ status: "completed", assistantText: "50만 원입니다.", route: "faq", traceId: done?.traceId });
    expect(row?.sources?.[0]?.chunkId).toBe("c1");
    const trace = await prisma!.messageTrace.findUnique({ where: { turnId: t.id } });
    expect(trace).toMatchObject({ totalInputTokens: 123, bStatus: "skipped", intent: "regulation" });
  });

  it("[D1] trace 토큰 합계가 INT를 넘으면 완료는 성공하고 컬럼은 NULL, data에 원값과 초과 표시를 남긴다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const r = result("답");
    // 개별 호출 usage는 각각 INT 이하지만 합계는 INT(2147483647) 초과
    const call = { status: "ok" as const, attempts: 1, latencyMs: 1, usage: { inputTokens: 2_000_000_000, outputTokens: 1 } };
    r.trace.jevCalls = [{ call: "turn", ...call }, { call: "relevance", chunkId: "c1", ...call }];
    r.trace.totalInputTokens = 4_000_000_000;
    const done = await repo.completeTurn(t.id, r);
    expect(done?.traceId).toBeTruthy();
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "completed", traceId: done?.traceId });
    const trace = await prisma!.messageTrace.findUnique({ where: { turnId: t.id } });
    expect(trace?.totalInputTokens).toBeNull();
    const data = trace?.data as { totalInputTokens?: unknown; storage?: { totalInputTokensOutOfRange?: unknown } };
    expect(data.totalInputTokens).toBe(4_000_000_000);
    expect(data.storage?.totalInputTokensOutOfRange).toBe(true);
  });

  it("[D1] trace 토큰 합계가 정확히 2147483647이면 컬럼에 그대로 저장하고 초과 표시가 없다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const r = result("답");
    r.trace.totalInputTokens = 2_147_483_647;
    await repo.completeTurn(t.id, r);
    const trace = await prisma!.messageTrace.findUnique({ where: { turnId: t.id } });
    expect(trace?.totalInputTokens).toBe(2_147_483_647);
    const data = trace?.data as { totalInputTokens?: unknown; storage?: unknown };
    expect(data.totalInputTokens).toBe(2_147_483_647);
    expect(data.storage).toBeUndefined();
  });

  it("[P4] route=error 완료는 error 메타데이터를 함께 저장, 정상 완료는 비운다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const r = result("일시적인 문제", "error");
    r.trace.errorCode = "JEV_UNAVAILABLE";
    await repo.completeTurn(t.id, r);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "completed", route: "error", errorCode: "JEV_UNAVAILABLE", errorRetryable: true });
    const t2 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(2), userText: "q2" });
    await repo.completeTurn(t2.id, result("정상"));
    expect(await repo.findTurnByClientMsgId(s.id, uuid(2))).toMatchObject({ errorCode: null, errorRetryable: null });
  });

  it("[P9] trace 삽입이 실패하면 전체 롤백 — 턴은 processing으로 남는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    await expectStrictSqlMode();
    const bad = result("답");
    bad.trace.knowledgeVersionId = "x".repeat(40); // CHAR(36) 초과 → trace insert 실패
    await expect(repo.completeTurn(t.id, bad)).rejects.toThrow();
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "processing", assistantText: null, traceId: null });
  });

  it("[P9] complete와 fail이 동시에 와도 하나만 종료 상태를 만든다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const [done, failed] = await Promise.all([repo.completeTurn(t.id, result("답")), repo.failTurn(t.id, "INTERNAL", false)]);
    expect(Number(done !== null) + Number(failed)).toBe(1);
    const row = await repo.findTurnByClientMsgId(s.id, uuid(1));
    expect(row?.status).toBe(done !== null ? "completed" : "failed");
    expect(await prisma!.messageTrace.count({ where: { turnId: t.id } })).toBe(done !== null ? 1 : 0);
  });

  it("[P5·P9] 저장 기한을 넘기면 트랜잭션이 롤백되고 늦은 완료가 남지 않는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    // 다른 트랜잭션이 턴 행을 4.5초 동안 잠근다(saveMs보다 길다) → completeTurn(saveMs 3000)은 잠금 대기 중이며,
    // DB 세션의 잠금 대기 제한(2초)이 없으면 holder가 끝날 때까지(약 4.5초) reject되지 않는다.
    // holder가 FOR UPDATE로 잠금을 얻은 뒤에만 completeTurn을 시작한다(barrier).
    let locked!: () => void;
    const lockAcquired = new Promise<void>((r) => (locked = r));
    const holder = prisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_turns WHERE id = ${t.id} FOR UPDATE`;
      locked();
      await new Promise((r) => setTimeout(r, 4500));
    }, { timeout: 8000 });
    holder.catch(() => {}); // 잠금 전 실패 시에도 unhandled rejection이 되지 않게 한다(아래 await에서 다시 던져짐)
    const endedEarly = holder.then(() => {
      throw new Error("holder가 잠금 전에 종료");
    });
    endedEarly.catch(() => {});
    await Promise.race([lockAcquired, endedEarly]);
    // 운영 기본 saveMs(3000)에서 DB 잠금 대기 2초가 실제 상한을 보장함을 검증 (holder는 saveMs보다 오래 잠금을 쥔다)
    const saveMs = 3000;
    const startedAt = Date.now();
    await expect(repo.completeTurn(t.id, result("늦은 답"), { saveMs })).rejects.toThrow();
    const elapsed = Date.now() - startedAt;
    // DB 세션의 행 잠금 대기 제한(2초)이 실제 상한이다
    expect(elapsed, `elapsed=${elapsed}ms`).toBeLessThanOrEqual(saveMs + 1000);
    expect(elapsed, `elapsed=${elapsed}ms`).toBeLessThanOrEqual(saveMs);
    await holder;
    await new Promise((r) => setTimeout(r, 500));
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "processing", assistantText: null, traceId: null });
    expect(await prisma!.messageTrace.count({ where: { turnId: t.id } })).toBe(0);
  }, 10_000);

  it("failTurn은 processing일 때만 실패로 바꾼다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    expect(await repo.failTurn(t.id, "INTERNAL", false)).toBe(true);
    expect(await repo.failTurn(t.id, "INTERNAL", false)).toBe(false);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "failed", errorCode: "INTERNAL", errorRetryable: false });
  });

  it("sweepProcessing은 남은 processing을 failed(retryable)로 바꾼다", async () => {
    const s = await repo.createSession("u1", "front-test");
    await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    expect(await repo.sweepProcessing("RESTARTED")).toBe(1);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "failed", errorCode: "RESTARTED", errorRetryable: true });
  });

  it("loadCompletedTurns: 이전 완료 턴만, 오름차순, limit개, 출처(title·section) 포함", async () => {
    const s = await repo.createSession("u1", "front-test");
    for (let n = 1; n <= 4; n++) {
      const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: `q${n}` });
      if (n !== 3) await repo.completeTurn(t.id, result(`a${n}`));
    }
    const turns = await repo.loadCompletedTurns(s.id, 4, 2);
    expect(turns.map((t) => t.turnSeq)).toEqual([1, 2]);
    expect(turns[0]).toEqual({ turnSeq: 1, userText: "q1", assistantText: "a1", sources: [{ title: "법인카드 규정", section: "한도" }] });
  });

  it("listTurns: 최신 limit개를 오름차순으로, hasMore 계산", async () => {
    const s = await repo.createSession("u1", "front-test");
    for (let n = 1; n <= 3; n++) await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: `q${n}` });
    const page = await repo.listTurns(s.id, { limit: 2 });
    expect(page.turns.map((t) => t.turnSeq)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);
    const older = await repo.listTurns(s.id, { limit: 2, beforeTurnSeq: 2 });
    expect(older).toMatchObject({ hasMore: false });
    expect(older.turns.map((t) => t.turnSeq)).toEqual([1]);
  });

  it("[I-3] 세션 목록은 created_at,id 순 — 페이지 사이에 앞 세션에 턴이 추가돼도 중복·누락 없다", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const id = uuid(n);
      // 4·5번은 created_at 동률(id로 타이브레이크)
      await prisma!.chatSession.create({ data: { id, userId: "u1", channel: "front-test", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n >= 5 ? 4 : n)) } });
      ids.push(id);
    }
    const first = await repo.listSessions({}, { limit: 2 });
    expect(first.items.map((s) => s.id)).toEqual([uuid(5), uuid(4)]);
    // 아직 보지 않은 뒤쪽 세션과 이미 본 앞쪽 세션 모두에 턴을 추가해 lastActiveAt을 흔든다
    await repo.reserveTurn({ sessionId: uuid(5), clientMsgId: uuid(101), userText: "a" });
    await repo.reserveTurn({ sessionId: uuid(1), clientMsgId: uuid(102), userText: "b" });
    const second = await repo.listSessions({}, { limit: 2, cursor: first.nextCursor! });
    const third = await repo.listSessions({}, { limit: 2, cursor: second.nextCursor! });
    expect([...first.items, ...second.items, ...third.items].map((s) => s.id)).toEqual([uuid(5), uuid(4), uuid(3), uuid(2), uuid(1)]);
    expect(third.nextCursor).toBeNull();
    expect(first.items[0]?.lastActiveAt).toBeTruthy();
  });
});
