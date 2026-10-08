import type { Chunk, IntentDef, IntentId } from "../domain/types";
import type { RecentTurn } from "../context/context";
import type { FaqCandidate } from "../retrieval/retriever";

export interface TurnJudgeRequest {
  message: string;
  recentTurns: RecentTurn[];
  faqCandidates: FaqCandidate[];
  intents: IntentDef[];
}

export interface RelevanceRequest {
  message: string;
  recentTurns: RecentTurn[];
  chunk: Chunk;
}

export interface ChoiceResult<T extends string> {
  choice: T;
  probabilities: Record<T, number>;
  confidence: number;
}

export interface TurnJudgment {
  intent: ChoiceResult<IntentId>;
  ambiguity: number;
  /** FAQ id 또는 "none". FAQ 후보가 없어 질문을 생략했으면 null */
  faq: ChoiceResult<string> | null;
}

export type JudgeErrorKind = "provider" | "timeout" | "aborted" | "invalid_response" | "too_large";

export interface JevCallAudit {
  call: "turn" | "relevance";
  chunkId?: string;
  status: "ok" | "failed" | "aborted";
  attempts: number;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
  /** 허용된 응답 필드만 (answers 객체). SDK 객체·헤더 금지 */
  answer?: unknown;
  errorKind?: JudgeErrorKind;
}

export type JudgeOutcome<T> =
  | { ok: true; value: T; audit: JevCallAudit }
  | { ok: false; errorKind: JudgeErrorKind; message: string; audit: JevCallAudit };

export interface Judge {
  judgeTurn(req: TurnJudgeRequest, signal: AbortSignal): Promise<JudgeOutcome<TurnJudgment>>;
  judgeRelevance(req: RelevanceRequest, signal: AbortSignal): Promise<JudgeOutcome<number>>;
}
