import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JudgmentPanel } from "./JudgmentPanel";

const trace = {
  route: "reference", bStatus: "partial", intent: "regulation",
  intentProbs: { regulation: 0.7, how_to: 0.2, error: 0.05, account_access: 0.03, smalltalk: 0.01, out_of_scope: 0.01 },
  inScope: 0.98, ambiguity: 0.2, manipulation: 0.33, faqChoice: "none", faqProb: 0.05, totalInputTokens: 900,
  latencyMs: { retrieval: 1, turn: 200, relevance: 380, total: 400 },
  candidates: [{ kind: "chunk", id: "card-002", bm25Rank: 1, bm25Score: 2, relevance: 0.66, status: "ok" }, { kind: "chunk", id: "card-009", bm25Rank: 2, bm25Score: 1, status: "failed" }],
};

describe("JudgmentPanel", () => {
  it("경로·B 상태·의도·문서 후보를 보여준다", () => {
    render(<JudgmentPanel trace={trace} />);
    expect(screen.getByText("reference")).toBeTruthy();
    expect(screen.getByText(/partial/)).toBeTruthy();
    expect(screen.getByText("regulation")).toBeTruthy();
    expect(screen.getByText("70.0%")).toBeTruthy();
    expect(screen.getByText(/manipulation 33\.0%/)).toBeTruthy();
    expect(screen.getByText("card-002")).toBeTruthy();
    expect(screen.getByText("0.66")).toBeTruthy();
    expect(screen.getByText(/failed/)).toBeTruthy();
    expect(screen.getByText(/900/)).toBeTruthy();
  });
  it("trace가 없으면 안내 문구", () => {
    render(<JudgmentPanel trace={undefined} />);
    expect(screen.getByText(/답변을 선택하면/)).toBeTruthy();
  });
});
