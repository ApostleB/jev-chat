import { describe, expect, it } from "vitest";
import { toTraceView } from "./trace-view";

const raw = {
  route: "extractive", bStatus: "succeeded", intent: "regulation",
  intentProbs: { regulation: 0.8, how_to: 0.1, error: 0.05, account_access: 0.03, smalltalk: 0.01, out_of_scope: 0.01 },
  inScope: 0.98, ambiguity: 0.1, faqChoice: "none", faqProb: 0.1, totalInputTokens: 1234,
  latencyMs: { retrieval: 2, turn: 300, relevance: 420, total: 450 },
  candidates: [
    { kind: "faq", id: "faq-a", bm25Rank: 1, bm25Score: 3.2, faqProb: 0.1 },
    { kind: "chunk", id: "card-002", bm25Rank: 2, bm25Score: 2.1, relevance: 0.91, status: "ok" },
  ],
  extra: { unknown: true },
};

describe("toTraceView", () => {
  it("필요한 필드만 뽑고 의도 확률을 큰 순으로 정렬", () => {
    const v = toTraceView(raw)!;
    expect(v.route).toBe("extractive");
    expect(v.intents.map((i) => i.id).slice(0, 2)).toEqual(["regulation", "how_to"]);
    expect(v.faqCandidates[0]).toMatchObject({ id: "faq-a", prob: 0.1 });
    expect(v.chunkCandidates[0]).toMatchObject({ id: "card-002", relevance: 0.91, status: "ok" });
    expect(v.totalInputTokens).toBe(1234);
  });
  it("형식이 틀리면 null", () => {
    expect(toTraceView({ route: 123 })).toBeNull();
    expect(toTraceView(null)).toBeNull();
  });
  it("A 미완료 trace(intentProbs null)도 표시 가능", () => {
    expect(toTraceView({ ...raw, intentProbs: null, intent: null, inScope: null })?.intents).toEqual([]);
  });
});
