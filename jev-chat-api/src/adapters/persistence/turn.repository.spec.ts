import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../core";
import { resetTestDb, testPrisma } from "./prisma";
import { TurnRepository } from "./turn.repository";

const prisma = testPrisma();
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
    // 다른 트랜잭션이 턴 행을 2.5초 동안 잠근다 → completeTurn(saveMs 1000)은 잠금 대기 중 기한 초과
    const holder = prisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_turns WHERE id = ${t.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 2500));
    }, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    await expect(repo.completeTurn(t.id, result("늦은 답"), { saveMs: 1000 })).rejects.toThrow();
    await holder;
    await new Promise((r) => setTimeout(r, 500));
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "processing", assistantText: null, traceId: null });
    expect(await prisma!.messageTrace.count({ where: { turnId: t.id } })).toBe(0);
  });

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
});
