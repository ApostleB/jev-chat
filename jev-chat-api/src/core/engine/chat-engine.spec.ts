import { describe, expect, it } from "vitest";
import { ChatEngine, type HandleMessageInput } from "./chat-engine";
import { ExtractiveAnswerer } from "../answer/extractive";
import { MESSAGES } from "../answer/messages";
import { chunkFixture, faqFixture } from "../testing/fixtures";
import {
  failedRelevance,
  failedTurn,
  FakeJudge,
  hangUntilAbort,
  InMemoryContextReader,
  makeSnapshot,
  okRelevance,
  okTurn,
} from "../testing/fakes";

const chunks = [
  chunkFixture({ id: "card-1", kind: "regulation", title: "법인카드 규정", section: "한도", text: "법인카드 1회 사용 한도는 50만 원이다" }),
  chunkFixture({ id: "card-2", kind: "regulation", title: "법인카드 규정", section: "회식비", text: "회식비는 1인당 5만 원 이내로 사용한다 법인카드" }),
];
const faqs = [faqFixture({ id: "faq-card", summary: "법인카드 1회 한도", variants: ["법인카드 한도 얼마예요"], answer: "1회 50만 원입니다.", sourceChunkId: "card-1" })];
const snapshot = makeSnapshot({ chunks, faqs });
const principal = { userId: "u1", roles: ["user" as const] };

function input(text: string, signal = new AbortController().signal, turnSeq = 1): HandleMessageInput {
  return { principal, sessionId: "s1", turnId: "t1", turnSeq, text, snapshot, signal };
}

function engine(judge: FakeJudge, turns = new InMemoryContextReader()) {
  return new ChatEngine({ judge, answerer: new ExtractiveAnswerer(), contextReader: turns });
}

describe("ChatEngine", () => {
  it("FAQ 확정: faq 경로, 남은 B는 abort, bStatus=skipped", async () => {
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.92, none: 0.08 } } }),
      (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0)),
    );
    const progress: string[] = [];
    const r = await engine(judge).handle(input("법인카드 한도 얼마예요"), (p) => progress.push(p.stage));
    expect(r.route).toBe("faq");
    expect(r.text).toContain("1회 50만 원입니다.");
    expect(r.sources.map((s) => s.chunkId)).toEqual(["card-1"]);
    expect(r.trace.bStatus).toBe("skipped");
    expect(judge.abortedRelevance.length).toBeGreaterThan(0);
    expect(progress).toEqual(["judging", "answering"]);
    expect(r.trace.faqChoice).toBe("faq-card");
    expect(r.trace.faqProb).toBe(0.92);
  });

  it("FAQ 미확정 → B 관련도로 extractive, 후보 trace에 관련도 기록", async () => {
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }, { faq: { choice: "none", confidence: 0.9, probabilities: { "faq-card": 0.1, none: 0.9 } } }),
      async (req) => okRelevance(req.chunk.id, req.chunk.id === "card-2" ? 0.93 : 0.2),
    );
    const r = await engine(judge).handle(input("회식비 한도"));
    expect(r.route).toBe("extractive");
    expect(r.sources.map((s) => s.chunkId)).toEqual(["card-2"]);
    expect(r.trace.bStatus).toBe("succeeded");
    const c2 = r.trace.candidates.find((c) => c.kind === "chunk" && c.id === "card-2");
    expect(c2).toMatchObject({ relevance: 0.93, status: "ok", contentHash: "hash-card-2" });
  });

  it("A와 B를 동시에 시작한다(A 결과를 기다리지 않고 B 호출)", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => (releaseTurn = r));
    const judge = new FakeJudge(
      async () => {
        await turnGate;
        return okTurn({ regulation: 1 });
      },
      async (req) => okRelevance(req.chunk.id, 0.9),
    );
    const p = engine(judge).handle(input("법인카드 회식비"));
    await new Promise((r) => setTimeout(r, 0));
    expect(judge.relevanceCalls.length).toBeGreaterThan(0);
    releaseTurn();
    await p;
  });

  it("A 실패 → error 경로, errorCode=JEV_UNAVAILABLE", async () => {
    const judge = new FakeJudge(async () => failedTurn(), async (req) => okRelevance(req.chunk.id, 0.9));
    const r = await engine(judge).handle(input("법인카드 한도"));
    expect(r.route).toBe("error");
    expect(r.text).toBe(MESSAGES.error);
    expect(r.trace.errorCode).toBe("JEV_UNAVAILABLE");
  });

  it("엔진 기한(signal) 전에 A가 안 끝나면 error", async () => {
    const ctrl = new AbortController();
    const judge = new FakeJudge(
      (_req, signal) => hangUntilAbort(signal, () => failedTurn()),
      (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0)),
    );
    const p = engine(judge).handle(input("법인카드 한도", ctrl.signal));
    setTimeout(() => ctrl.abort(), 5);
    const r = await p;
    expect(r.route).toBe("error");
    expect(r.trace.errorCode).toBe("JEV_UNAVAILABLE");
  });

  it("B 전부 실패 → error(relevance_failed)", async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => failedRelevance(req.chunk.id));
    const r = await engine(judge).handle(input("법인카드 회식비"));
    expect(r.route).toBe("error");
    expect(r.trace.bStatus).toBe("failed");
  });

  it("B 일부 실패 → 성공분으로 결정, bStatus=partial", async () => {
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }),
      async (req) => (req.chunk.id === "card-1" ? failedRelevance("card-1") : okRelevance("card-2", 0.6)),
    );
    const r = await engine(judge).handle(input("법인카드 회식비"));
    expect(r.trace.bStatus).toBe("partial");
    expect(r.route).toBe("reference");
  });

  it("문서 후보 0개 → B 호출 없음, bStatus=empty, fallback", async () => {
    const judge = new FakeJudge(async () => okTurn({ how_to: 1 }), async (req) => okRelevance(req.chunk.id, 0.9));
    const r = await engine(judge).handle(input("zzz qqq"));
    expect(judge.relevanceCalls).toHaveLength(0);
    expect(r.trace.bStatus).toBe("empty");
    expect(r.route).toBe("fallback");
  });

  it("범위 밖 → blocked, B는 abort", async () => {
    const judge = new FakeJudge(
      async () => okTurn({ out_of_scope: 0.9, regulation: 0.1 }),
      (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0)),
    );
    const r = await engine(judge).handle(input("법인카드로 점심 뭐 먹지"));
    expect(r.route).toBe("blocked");
    expect(r.trace.bStatus).toBe("skipped");
  });

  it("문맥: 이전 완료 턴을 Judge 요청에 같은 recentTurns로 전달", async () => {
    const turns = new InMemoryContextReader([{ turnSeq: 1, userText: "법인카드 한도?", assistantText: "1회 50만 원", sources: [{ title: "법인카드 규정", section: "제3조 사용 한도" }] }]);
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.1));
    const r = await engine(judge, turns).handle(input("그럼 회식비는요?", new AbortController().signal, 2));
    expect(judge.turnCalls[0]?.recentTurns).toEqual([
      { role: "user", text: "법인카드 한도?" },
      { role: "assistant", text: "1회 50만 원" },
    ]);
    for (const call of judge.relevanceCalls) expect(call.recentTurns).toEqual(judge.turnCalls[0]?.recentTurns);
    expect(r.trace.contextTurnSeqs).toEqual([1]);
    expect(r.trace.retrieval.chunkQueries).toHaveLength(2);
  });

  it("헬프데스크: error+account_access ≥ 0.5면 답변 끝에 붙인다", async () => {
    const judge = new FakeJudge(async () => okTurn({ error: 0.6, how_to: 0.4 }), async (req) => okRelevance(req.chunk.id, 0.9));
    const r = await engine(judge).handle(input("법인카드 결제 오류"));
    expect(r.text.endsWith(MESSAGES.helpdesk(snapshot.helpdesk))).toBe(true);
  });

  it("trace: 토큰 합산, 스냅샷 버전, 템플릿 버전, 모델", async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }, { inputTokens: 100 }), async (req) => okRelevance(req.chunk.id, 0.9, 50));
    const r = await engine(judge).handle(input("법인카드 회식비"));
    expect(r.trace.totalInputTokens).toBe(100 + 50 * judge.relevanceCalls.length);
    expect(r.trace.knowledgeVersionId).toBe("v1");
    expect(r.trace.templateVersion).toBe("v1");
    expect(r.trace.model).toBe("jev-1.13.0");
    expect(r.trace.jevCalls.length).toBe(1 + judge.relevanceCalls.length);
  });

  it("FAQ 조기 확정이어도 이미 보낸 B 호출은 jevCalls·토큰·candidates에 남는다", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => (releaseTurn = r));
    const judge = new FakeJudge(
      async () => {
        await turnGate;
        return okTurn({ regulation: 1 }, { inputTokens: 100, faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.92, none: 0.08 } } });
      },
      (req, signal) => (req.chunk.id === "card-1" ? Promise.resolve(okRelevance("card-1", 0.2, 50)) : hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0))),
    );
    const p = engine(judge).handle(input("법인카드 회식비"));
    await new Promise((r) => setTimeout(r, 5));
    releaseTurn();
    const r = await p;
    expect(r.route).toBe("faq");
    expect(r.trace.bStatus).toBe("skipped");
    expect(r.trace.jevCalls.length).toBe(1 + r.trace.retrieval.chunkCandidateIds.length);
    expect(r.trace.totalInputTokens).toBe(100 + 50);
    expect(r.trace.candidates.find((c) => c.id === "card-1")).toMatchObject({ status: "ok", relevance: 0.2 });
    expect(r.trace.candidates.find((c) => c.id === "card-2")).toMatchObject({ status: "aborted" });
  });

  it("judgeTurn이 reject하면 handle도 reject하고 진행 중인 B는 abort된다", async () => {
    const judge = new FakeJudge(
      async () => {
        throw new Error("boom");
      },
      (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0)),
    );
    await expect(engine(judge).handle(input("법인카드 회식비"))).rejects.toThrow("boom");
    expect(judge.abortedRelevance.length).toBeGreaterThan(0);
  });

  it("A가 reject한 뒤 B가 늦게 reject해도 unhandled rejection이 없다", async () => {
    let bRejected = 0;
    const judge = new FakeJudge(
      async () => {
        throw new Error("boom");
      },
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => {
            bRejected++;
            reject(new Error("late"));
          }, 5),
        ),
    );
    await expect(engine(judge).handle(input("법인카드 회식비"))).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 30));
    expect(bRejected).toBeGreaterThan(0);
  });

  it("judgeRelevance가 동기로 throw해도 handle만 reject하고 unhandled rejection이 없다", async () => {
    let lateRejected = 0;
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }),
      (req) => {
        if (req.chunk.id === "card-2") throw new Error("sync boom");
        return new Promise((_resolve, reject) =>
          setTimeout(() => {
            lateRejected++;
            reject(new Error("late"));
          }, 5),
        );
      },
    );
    await expect(engine(judge).handle(input("법인카드 회식비"))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(judge.relevanceCalls).toHaveLength(2);
    expect(lateRejected).toBeGreaterThan(0);
  });

  describe("기한 초과와 취소의 구분 (0-5)", () => {
    const hangingJudge = () =>
      new FakeJudge(
        (_req, signal) => hangUntilAbort(signal, () => failedTurn()),
        (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0)),
      );

    it("기한(TimeoutError) 초과로 A가 미완료면 jevCalls[0]은 failed/timeout", async () => {
      const r = await engine(hangingJudge()).handle(input("법인카드 한도", AbortSignal.timeout(5)));
      expect(r.route).toBe("error");
      expect(r.trace.jevCalls[0]).toMatchObject({ call: "turn", status: "failed", errorKind: "timeout" });
    });

    it("일반 abort면 jevCalls[0]은 aborted/aborted", async () => {
      const ctrl = new AbortController();
      const p = engine(hangingJudge()).handle(input("법인카드 한도", ctrl.signal));
      setTimeout(() => ctrl.abort(), 5);
      const r = await p;
      expect(r.route).toBe("error");
      expect(r.trace.jevCalls[0]).toMatchObject({ call: "turn", status: "aborted", errorKind: "aborted" });
    });

    it("A 성공(FAQ 미확정) 후 B 대기 중 기한 초과 → relevance_failed error, 기한+100ms 이내", async () => {
      const judge = new FakeJudge(
        async () => okTurn({ regulation: 1 }),
        (req, signal) => hangUntilAbort(signal, () => okRelevance(req.chunk.id, 0.9)),
      );
      const t = performance.now();
      const r = await engine(judge).handle(input("법인카드 회식비", AbortSignal.timeout(30)));
      expect(performance.now() - t).toBeLessThan(30 + 100);
      expect(r.route).toBe("error");
      expect(r.trace.bStatus).toBe("failed");
      expect(r.trace.errorCode).toBe("JEV_UNAVAILABLE");
    });

    it("멈춘 ContextReader도 엔진 기한 안에서 error로 끝난다", async () => {
      const stuck = { loadCompletedTurns: () => new Promise<never>(() => {}) };
      const judge = hangingJudge();
      const t = performance.now();
      const r = await engine(judge, stuck as never).handle(input("법인카드 한도", AbortSignal.timeout(20)));
      expect(performance.now() - t).toBeLessThan(100);
      expect(r.route).toBe("error");
    });
  });
});
