import { describe, expect, it } from "vitest";
import { decideFromRelevance, decideFromTurn, inScopeProbability, needsHelpdesk, type ScoredChunk } from "./router";
import { DEFAULT_POLICY as P } from "../domain/policy";
import type { IntentId } from "../domain/types";
import type { JudgeOutcome, TurnJudgment } from "../judge/ports";
import { chunkFixture, faqFixture } from "../testing/fixtures";

const audit = { call: "turn" as const, status: "ok" as const, attempts: 1, latencyMs: 10 };

function probs(p: Partial<Record<IntentId, number>>): Record<IntentId, number> {
  return { regulation: 0, how_to: 0, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0, ...p };
}

function turn(p: Partial<Record<IntentId, number>>, ambiguity = 0, faq: TurnJudgment["faq"] = null): JudgeOutcome<TurnJudgment> {
  const probabilities = probs(p);
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]) as IntentId;
  return { ok: true, audit, value: { intent: { choice, probabilities, confidence: 0.9 }, ambiguity, faq } };
}

const faqA = faqFixture({ id: "faq-a" });
const faqCands = [{ faq: faqA, bm25Rank: 1, bm25Score: 2 }];

describe("inScopeProbability / needsHelpdesk", () => {
  it("ERP 의도 4개의 합", () => {
    expect(inScopeProbability(probs({ regulation: 0.3, how_to: 0.2, error: 0.1, account_access: 0.1, smalltalk: 0.3 }))).toBeCloseTo(0.7);
  });
  it("error+account_access ≥ 0.5면 헬프데스크", () => {
    expect(needsHelpdesk(P, probs({ error: 0.3, account_access: 0.2 }))).toBe(true);
    expect(needsHelpdesk(P, probs({ error: 0.3, account_access: 0.19 }))).toBe(false);
  });
});

describe("부동소수점 경계", () => {
  it("in_scope 합이 0.4(0.39999999999999997)여도 block 임계에서 clarify(scope)", () => {
    const r = decideFromTurn(P, turn({ regulation: 0.05, how_to: 0.3, error: 0.05, out_of_scope: 0.6 }), faqCands);
    expect(r).toEqual({ route: "clarify", reason: "scope" });
  });
  // 참고(6-8): needsHelpdesk는 두 값만 더하므로 round9가 없어도 이 경계는 통과한다. 5~9자리 소수 쌍 수십만 개를 탐색해도
  // 부동소수 합이 0.5 미만이 되는 조합을 찾지 못해, 여기의 round9는 방어용일 뿐 이 테스트로 필요성을 증명할 수 없다.
  it("helpdesk 합 0.1+0.2+0.2 = 0.5 경계는 헬프데스크", () => {
    expect(needsHelpdesk(P, probs({ error: 0.1 + 0.2, account_access: 0.2 }))).toBe(true);
    expect(needsHelpdesk(P, probs({ error: 0.1 + 0.2, account_access: 0.19 }))).toBe(false);
  });
});

describe("decideFromTurn (규칙 1~5)", () => {
  it("1: A 실패면 error", () => {
    const failed: JudgeOutcome<TurnJudgment> = { ok: false, errorKind: "provider", message: "529", audit: { ...audit, status: "failed" } };
    expect(decideFromTurn(P, failed, faqCands)).toEqual({ route: "error", reason: "turn_failed" });
  });
  it("1: A 미완료(null)면 error", () => {
    expect(decideFromTurn(P, null, faqCands)).toEqual({ route: "error", reason: "turn_failed" });
  });
  it("2: in_scope < 0.4면 blocked, smalltalk 최고면 smalltalk 변형", () => {
    expect(decideFromTurn(P, turn({ smalltalk: 0.7, regulation: 0.3 }), faqCands)).toEqual({ route: "blocked", variant: "smalltalk" });
    expect(decideFromTurn(P, turn({ out_of_scope: 0.61, regulation: 0.39 }), faqCands)).toEqual({ route: "blocked", variant: "out_of_scope" });
  });
  it("3: 0.4 ≤ in_scope < 0.6이면 clarify(scope) — 경계 0.4는 clarify", () => {
    expect(decideFromTurn(P, turn({ regulation: 0.4, out_of_scope: 0.6 }), faqCands)).toEqual({ route: "clarify", reason: "scope" });
    expect(decideFromTurn(P, turn({ regulation: 0.59, out_of_scope: 0.41 }), faqCands)).toEqual({ route: "clarify", reason: "scope" });
  });
  it("4: in_scope ≥ 0.6이고 ambiguous ≥ 0.7이면 clarify(ambiguous)", () => {
    expect(decideFromTurn(P, turn({ regulation: 0.6, out_of_scope: 0.4 }, 0.7), faqCands)).toEqual({ route: "clarify", reason: "ambiguous" });
  });
  it("5: faq 확률 ≥ 0.8이면 faq (경계 0.8 포함)", () => {
    const t = turn({ regulation: 1 }, 0.1, { choice: "faq-a", confidence: 0.7, probabilities: { "faq-a": 0.8, none: 0.2 } });
    expect(decideFromTurn(P, t, faqCands)).toEqual({ route: "faq", faq: faqA });
  });
  it("faq 확률 0.79면 B가 필요(null)", () => {
    const t = turn({ regulation: 1 }, 0.1, { choice: "faq-a", confidence: 0.7, probabilities: { "faq-a": 0.79, none: 0.21 } });
    expect(decideFromTurn(P, t, faqCands)).toBeNull();
  });
  it("faq 선택이 none이면 null", () => {
    const t = turn({ regulation: 1 }, 0.1, { choice: "none", confidence: 0.9, probabilities: { "faq-a": 0.05, none: 0.95 } });
    expect(decideFromTurn(P, t, faqCands)).toBeNull();
  });
  it("faq 질문을 생략했으면(null) B가 필요", () => {
    expect(decideFromTurn(P, turn({ how_to: 1 }), [])).toBeNull();
  });
});

function scored(id: string, relevance: number, bm25Rank: number, title = "문서"): ScoredChunk {
  return { candidate: { chunk: chunkFixture({ id, title }), bm25Rank, bm25Score: 1, matchedBy: ["q1"] }, relevance };
}

describe("decideFromRelevance (규칙 6~9)", () => {
  it("6: ≥ 0.8 청크를 관련도 순으로 최대 2개", () => {
    const d = decideFromRelevance(P, [scored("a", 0.85, 2), scored("b", 0.95, 3), scored("c", 0.9, 1)], "succeeded");
    expect(d).toEqual({ route: "extractive", chunks: [expect.objectContaining({ id: "b" }), expect.objectContaining({ id: "c" })] });
  });
  it("6: 동점이면 BM25 순위가 높은 쪽", () => {
    const d = decideFromRelevance(P, [scored("a", 0.9, 2), scored("b", 0.9, 1)], "succeeded");
    expect(d.route === "extractive" && d.chunks.map((c) => c.id)).toEqual(["b", "a"]);
  });
  it("7: 0.5 ≤ 최고 < 0.8이면 reference(1위)", () => {
    expect(decideFromRelevance(P, [scored("a", 0.5, 1), scored("b", 0.79, 2)], "partial")).toEqual({
      route: "reference",
      chunk: expect.objectContaining({ id: "b" }),
    });
  });
  it("8: B 전부 실패면 error", () => {
    expect(decideFromRelevance(P, [], "failed")).toEqual({ route: "error", reason: "relevance_failed" });
  });
  it("9: 후보 0개(empty)면 fallback", () => {
    expect(decideFromRelevance(P, [], "empty")).toEqual({ route: "fallback" });
  });
  it("9: 모두 0.5 미만이면 fallback", () => {
    expect(decideFromRelevance(P, [scored("a", 0.49, 1)], "succeeded")).toEqual({ route: "fallback" });
  });
});
