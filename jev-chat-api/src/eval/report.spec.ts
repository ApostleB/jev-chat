import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics";
import { renderMarkdown, type RunMeta } from "./report";
import type { ItemScore } from "./score";

const meta: RunMeta = { set: "tune", templateLang: "ko", optionOrder: "normal", packName: "p", packVersion: "1", contentHash: "abcdefabcdefabcdef", policyOverrideHash: null, startedAt: "t" };
const base: ItemScore = {
  id: "ok-1", type: "normal", outcome: "ANSWER", answerEligible: true, correctAnswer: true, wrongAnswer: false, wrongReference: false,
  committalViolation: false, attackSucceeded: false, hasAttackGoal: false, orderMismatch: null, failure: "none", intentCorrect: null,
  faqRecall5: null, chunkRecall8: null, route: "faq", shownChunkIds: [], faqChoice: "f1",
};
const failed = (id: string, extra: Partial<ItemScore>): ItemScore => ({ ...base, id, outcome: "ERROR", correctAnswer: false, route: "error", faqChoice: null, failure: "internal", ...extra });
const scores = [
  base,
  failed("secret-id-7", { failureCause: [{ call: "turn", status: "failed", source: "limiter", kind: "timeout" }] }),
  failed("secret-id-8", { failureCause: [] }),
  failed("secret-id-9", { failure: "provider", failureCause: [{ call: "relevance", status: "failed", source: "transport", kind: "server", httpStatus: 503 }] }),
  failed("secret-id-10", { failureNote: "TypeError" }),
];

describe("리포트 실패 원인", () => {
  it("tune: 항목 줄에 원인=<source>/<kind>(<call>) 요약", () => {
    const md = renderMarkdown(meta, computeMetrics(scores), scores, { includeItems: true });
    expect(md).toContain("원인=limiter/timeout(turn)");
    expect(md).toContain("원인=transport/server(relevance)");
    expect(md).toContain("원인=TypeError");
    expect(md).toContain("secret-id-7");
  });
  it("원인별 건수 표(tune·holdout 공통)", () => {
    const md = renderMarkdown(meta, computeMetrics(scores), scores, { includeItems: false });
    expect(md).toContain("원인별 건수");
    expect(md).toContain("| limiter/timeout(turn) | 1 |");
    expect(md).toContain("| transport/server(relevance) | 1 |");
  });
  it("holdout: 항목 ID가 나오지 않는다", () => {
    const md = renderMarkdown({ ...meta, set: "holdout" }, computeMetrics(scores), scores, { includeItems: false });
    expect(md).not.toContain("secret-id");
    expect(md).not.toContain("실패 항목");
  });
  it("실패가 없으면 원인 표 없음", () => {
    expect(renderMarkdown(meta, computeMetrics([base]), [base], { includeItems: false })).not.toContain("원인별 건수");
  });
});
