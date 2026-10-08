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

/** 실패 원인 증거. 평가에서 외부 장애(429/529/5xx/연결)와 내부·설정 오류를 구분하는 데 쓴다. 원문 메시지·헤더·키는 담지 않는다. */
export interface JevCallCause {
  source: "transport" | "limiter" | "response" | "size";
  /** transport: rate_limited|overloaded|server|timeout|connection|client|aborted, limiter: timeout|oversized|aborted */
  kind?: string;
  status?: number;
}

/**
 * 호출 1건의 감사 기록. 엔진이 만드는 합성 audit(`attempts: 0`)은 "미완료·미측정"을 뜻한다
 * (기한 초과·취소로 결과를 받지 못했거나 시작조차 하지 않은 호출). 실제 시도 횟수·지연이 아니다.
 */
export interface JevCallAudit {
  call: "turn" | "relevance";
  chunkId?: string;
  status: "ok" | "failed" | "aborted";
  attempts: number;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** 요청 전 추정 입력 토큰(estimateTokens). 실제 usage와의 오차 비교용 */
  estimatedInputTokens?: number;
  model?: string;
  /** 허용된 응답 필드만 (answers 객체). SDK 객체·헤더 금지 */
  answer?: unknown;
  errorKind?: JudgeErrorKind;
  cause?: JevCallCause;
}

export type JudgeOutcome<T> =
  | { ok: true; value: T; audit: JevCallAudit }
  | { ok: false; errorKind: JudgeErrorKind; message: string; audit: JevCallAudit };

export interface Judge {
  judgeTurn(req: TurnJudgeRequest, signal: AbortSignal): Promise<JudgeOutcome<TurnJudgment>>;
  judgeRelevance(req: RelevanceRequest, signal: AbortSignal): Promise<JudgeOutcome<number>>;
}
