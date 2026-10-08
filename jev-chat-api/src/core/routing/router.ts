import { ERP_INTENTS, type Chunk, type Faq, type IntentId, type Policy } from "../domain/types";
import type { JudgeOutcome, TurnJudgment } from "../judge/ports";
import type { ChunkCandidate, FaqCandidate } from "../retrieval/retriever";

export type BStatus = "empty" | "succeeded" | "partial" | "failed" | "skipped";

export interface ScoredChunk {
  candidate: ChunkCandidate;
  relevance: number;
}

export type RouteDecision =
  | { route: "error"; reason: "turn_failed" | "relevance_failed" }
  | { route: "blocked"; variant: "smalltalk" | "out_of_scope" }
  | { route: "clarify"; reason: "scope" | "ambiguous" }
  | { route: "faq"; faq: Faq }
  | { route: "extractive"; chunks: Chunk[] }
  | { route: "reference"; chunk: Chunk }
  | { route: "fallback" };

export function inScopeProbability(probs: Record<IntentId, number>): number {
  return ERP_INTENTS.reduce((sum, id) => sum + (probs[id] ?? 0), 0);
}

export function needsHelpdesk(policy: Policy, probs: Record<IntentId, number>): boolean {
  return (probs.error ?? 0) + (probs.account_access ?? 0) >= policy.helpdesk;
}

/** 규칙 1~5. 종료가 결정되면 RouteDecision, B 결과가 필요하면 null. */
export function decideFromTurn(
  policy: Policy,
  turn: JudgeOutcome<TurnJudgment> | null,
  faqCandidates: FaqCandidate[],
): RouteDecision | null {
  if (!turn || !turn.ok) return { route: "error", reason: "turn_failed" };
  const { intent, ambiguity, faq } = turn.value;
  const inScope = inScopeProbability(intent.probabilities);
  if (inScope < policy.inScope.block) {
    const p = intent.probabilities;
    return { route: "blocked", variant: p.smalltalk >= p.out_of_scope ? "smalltalk" : "out_of_scope" };
  }
  if (inScope < policy.inScope.clarify) return { route: "clarify", reason: "scope" };
  if (ambiguity >= policy.ambiguous) return { route: "clarify", reason: "ambiguous" };
  if (faq && faq.choice !== "none" && (faq.probabilities[faq.choice] ?? 0) >= policy.faq) {
    const match = faqCandidates.find((c) => c.faq.id === faq.choice);
    if (match) return { route: "faq", faq: match.faq };
  }
  return null;
}

function byRelevance(a: ScoredChunk, b: ScoredChunk): number {
  return b.relevance - a.relevance || a.candidate.bm25Rank - b.candidate.bm25Rank;
}

/** 규칙 6~9. */
export function decideFromRelevance(policy: Policy, scored: ScoredChunk[], bStatus: BStatus): RouteDecision {
  const sorted = [...scored].sort(byRelevance);
  const answers = sorted.filter((s) => s.relevance >= policy.relevance.answer);
  if (answers.length > 0) return { route: "extractive", chunks: answers.slice(0, 2).map((s) => s.candidate.chunk) };
  const top = sorted[0];
  if (top && top.relevance >= policy.relevance.reference) return { route: "reference", chunk: top.candidate.chunk };
  if (bStatus === "failed") return { route: "error", reason: "relevance_failed" };
  return { route: "fallback" };
}
