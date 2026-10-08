import { describe, expect, it } from "vitest";
import { TypesafeJudge } from "./typesafe-judge";
import { JevLimiter } from "./limiter";
import { JevTransportError, type JevTransport, type JevTransportResult } from "./transport";
import { DEFAULT_INTENTS, type JevRequest, type Chunk } from "../../core";

const limiter = () => new JevLimiter({ maxConcurrent: 10, maxRequestsPerSecond: 100, maxTokensPerSecond: 1_000_000, maxWaitMs: 100 });
const noSleep = async () => {};
const signal = () => new AbortController().signal;

const chunk: Chunk = { id: "c1", module: "m", kind: "regulation", title: "법인카드 규정", section: "한도", text: "1회 50만 원", tags: [], updatedAt: "2026-01-01", contentHash: "h" };

class ScriptedTransport implements JevTransport {
  readonly sent: JevRequest[] = [];
  constructor(private readonly script: (JevTransportResult | JevTransportError)[]) {}
  async send(payload: JevRequest): Promise<JevTransportResult> {
    this.sent.push(payload);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof JevTransportError) throw next;
    return next;
  }
}

const turnAnswers = {
  intent: { type: "choice", choice: "regulation", confidence: 0.9, probabilities: { regulation: 0.9, how_to: 0.1, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0 } },
  ambiguous: { type: "noul", noul: 0.1 },
};
const ok = (answers: unknown): JevTransportResult => ({ model: "jev-1.13.0", answers, usage: { inputTokens: 100, outputTokens: 5 } });

function judge(transport: JevTransport) {
  return new TypesafeJudge({ transport, limiter: limiter(), attemptTimeoutMs: 1000, sleep: noSleep });
}

describe("TypesafeJudge.judgeTurn", () => {
  it("성공: 파싱된 판단과 audit", async () => {
    const t = new ScriptedTransport([ok(turnAnswers)]);
    const r = await judge(t).judgeTurn({ message: "법인카드 한도", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.intent.choice).toBe("regulation");
    expect(r.audit).toMatchObject({ call: "turn", status: "ok", attempts: 1, model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 5 } });
    expect(r.audit.estimatedInputTokens).toBeGreaterThan(0);
    expect(r.audit.answer).toEqual(turnAnswers);
    expect(t.sent[0]?.model).toBe("jev-1.13.0");
  });

  it("429/529/5xx/timeout/connection은 1회 재시도", async () => {
    for (const kind of ["rate_limited", "overloaded", "server", "timeout", "connection"] as const) {
      const t = new ScriptedTransport([new JevTransportError(kind, "x"), ok(turnAnswers)]);
      const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
      expect(r.ok, kind).toBe(true);
      expect(r.audit.attempts).toBe(2);
    }
  });

  it("두 번 실패하면 provider 실패(재시도는 1회뿐)", async () => {
    const t = new ScriptedTransport([new JevTransportError("overloaded", "529"), new JevTransportError("overloaded", "529")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(r.audit).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("client(4xx) 오류는 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([new JevTransportError("client", "400")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(t.sent).toHaveLength(1);
  });

  it("abort는 aborted로, 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([new JevTransportError("aborted", "abort")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(r.audit.status).toBe("aborted");
  });

  it("응답 형식 오류는 invalid_response, 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([ok({ intent: { type: "noul", noul: 1 } })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "invalid_response" });
    expect(t.sent).toHaveLength(1);
  });

  it("요청이 한도를 넘으면 전송하지 않고 too_large", async () => {
    const t = new ScriptedTransport([]);
    const r = await judge(t).judgeTurn({ message: "가".repeat(40000), recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "too_large" });
    expect(t.sent).toHaveLength(0);
  });

  it("FAQ 후보가 축소돼도 실제로 보낸 후보 id로 파싱한다", async () => {
    const huge = "가".repeat(15000);
    const faqCandidates = ["f1", "f2"].map((id, i) => ({
      faq: { id, intent: "regulation" as const, summary: "s", appliesWhen: "a", answer: huge, sourceChunkId: null, variants: [] },
      bm25Rank: i + 1,
      bm25Score: 1,
    }));
    const t = new ScriptedTransport([ok({ ...turnAnswers, faq: { type: "choice", choice: "f1", confidence: 0.9, probabilities: { f1: 0.9, none: 0.1 } } })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates, intents: DEFAULT_INTENTS }, signal());
    expect(r.ok).toBe(true);
    expect(Object.keys((t.sent[0]?.questions.faq as { criteria: object }).criteria)).toEqual(["f1", "none"]);
  });

  it("[P3] 실패 audit에 원인(transport kind·status)을 남긴다", async () => {
    const t = new ScriptedTransport([new JevTransportError("client", "401", { status: 401 })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r.audit.cause).toEqual({ source: "transport", kind: "client", status: 401 });
    const t2 = new ScriptedTransport([new JevTransportError("server", "503", { status: 503 }), new JevTransportError("server", "503", { status: 503 })]);
    const r2 = await judge(t2).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r2.audit.cause).toEqual({ source: "transport", kind: "server", status: 503 });
  });

  it("[P3] 제한기 거절은 limiter 원인으로 남는다", async () => {
    const tiny = new JevLimiter({ maxConcurrent: 10, maxRequestsPerSecond: 100, maxTokensPerSecond: 1, maxWaitMs: 100 });
    const j = new TypesafeJudge({ transport: new ScriptedTransport([]), limiter: tiny, attemptTimeoutMs: 1000, sleep: noSleep });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(r.audit.cause).toEqual({ source: "limiter", kind: "oversized" });
  });

  it("[P3] 트랜스포트가 알 수 없는 예외를 던지면 재시도 없이 그대로 전파", async () => {
    const t: JevTransport = { send: async () => { throw new TypeError("bug"); } };
    await expect(judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal())).rejects.toThrow(TypeError);
  });

  it("[P2] Retry-After가 maxRetryWaitMs보다 길면 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([Object.assign(new JevTransportError("overloaded", "529", { status: 529 }), { retryAfterMs: 5000 })]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, maxRetryWaitMs: 2000, sleep: noSleep });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(t.sent).toHaveLength(1);
  });

  it("[P2] 재시도 대기 중 취소되면 aborted", async () => {
    const ctrl = new AbortController();
    const t = new ScriptedTransport([new JevTransportError("server", "503", { status: 503 }), ok(turnAnswers)]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, sleep: async () => ctrl.abort() });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, ctrl.signal);
    expect(r).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(t.sent).toHaveLength(1);
  });

  it("재시도 대기 시간은 retryAfterMs를 따른다", async () => {
    const waits: number[] = [];
    const t = new ScriptedTransport([Object.assign(new JevTransportError("rate_limited", "429"), { retryAfterMs: 300 }), ok(turnAnswers)]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, sleep: async (ms) => void waits.push(ms) });
    await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(waits).toEqual([300]);
  });
});

describe("TypesafeJudge.judgeRelevance", () => {
  it("noul 값과 chunkId audit", async () => {
    const t = new ScriptedTransport([ok({ relevant: { type: "noul", noul: 0.87 } })]);
    const r = await judge(t).judgeRelevance({ message: "q", recentTurns: [], chunk }, signal());
    expect(r).toMatchObject({ ok: true, value: 0.87 });
    expect(r.audit).toMatchObject({ call: "relevance", chunkId: "c1" });
  });
});
