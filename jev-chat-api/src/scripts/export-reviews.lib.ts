import { INTENT_IDS } from "../core";

type Outcome = "ANSWER" | "REFERENCE" | "HOLD" | "BLOCK" | "ERROR";
type SourceLike = { chunkId: string };

export interface ReviewLike {
  id: string;
  verdict: string;
  expectedIntent: string | null;
  expectedFaqId: string | null;
  expectedChunkIds: unknown;
  note: string | null;
  trace: {
    route: string;
    intent: string | null;
    faqChoice: string | null;
    knowledgeVersionId: string | null;
    data: unknown;
    turn: { userText: string; sources: unknown };
  };
}
export interface ContextTurnLike {
  userText: string;
  assistantText: string | null;
  sources: unknown;
}

function routeToOutcome(route: string): Outcome {
  if (route === "faq" || route === "extractive") return "ANSWER";
  if (route === "reference") return "REFERENCE";
  if (route === "blocked") return "BLOCK";
  if (route === "error") return "ERROR";
  return "HOLD";
}

const isIntentId = (v: string | null): v is (typeof INTENT_IDS)[number] => v !== null && (INTENT_IDS as readonly string[]).includes(v);

/**
 * 검수 1건을 평가 항목으로 바꾼다. 평가 스키마(계획 3 EvalItemSchema)의 규칙을 지킨다:
 * - expect.intent는 INTENT_IDS 중 하나이거나 **생략**한다(null 금지).
 *   검수자가 지정한 expectedIntent가 INTENT_IDS 밖이면 사람이 고쳐야 하므로 라벨 필요로 분류한다.
 * - 문맥 일부가 사라졌거나 정답 라벨을 정할 수 없으면 expect 없이 라벨 필요(ready=false)로 분류한다.
 */
export function buildExportItem(r: ReviewLike, ctxRows: ContextTurnLike[]): { ready: boolean; item: Record<string, unknown> } {
  const turn = r.trace.turn;
  const data = (r.trace.data ?? {}) as { contextTurnSeqs?: number[] };
  const turns = ctxRows.flatMap((t) => [
    { role: "user", text: t.userText },
    { role: "assistant", text: t.assistantText ?? "", sources: ((t.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId) },
  ]);
  const shown = ((turn.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId);
  const outcome = routeToOutcome(r.trace.route);
  const expectedChunks = Array.isArray(r.expectedChunkIds) && r.expectedChunkIds.length > 0 ? (r.expectedChunkIds as string[]) : null;
  // 보관 기간 정리 등으로 참조 턴 일부가 사라졌으면 문맥이 불완전하다 → 자동 라벨 금지
  const contextComplete = ctxRows.length === (data.contextTurnSeqs?.length ?? 0);

  const intentBad = r.expectedIntent !== null && !isIntentId(r.expectedIntent);
  const intent = isIntentId(r.expectedIntent) ? r.expectedIntent : isIntentId(r.trace.intent) ? r.trace.intent : undefined;
  const intentField = intent ? { intent } : {};

  let expect: Record<string, unknown> | null = null;
  if (!contextComplete || intentBad) {
    expect = null;
  } else if (r.verdict === "correct") {
    expect = {
      ...intentField,
      allowed_outcomes: [outcome],
      ...(r.trace.route === "faq" && r.trace.faqChoice ? { faq_ids: [r.trace.faqChoice] } : {}),
      ...((outcome === "ANSWER" || outcome === "REFERENCE") && shown.length > 0 ? { acceptable_chunk_ids: shown, required_chunk_ids_any: shown } : {}),
      attack_goal: null,
    };
  } else if (r.expectedFaqId || expectedChunks) {
    expect = {
      ...intentField,
      allowed_outcomes: ["ANSWER"],
      ...(r.expectedFaqId ? { faq_ids: [r.expectedFaqId] } : {}),
      ...(expectedChunks ? { acceptable_chunk_ids: expectedChunks, required_chunk_ids_any: expectedChunks } : {}),
      attack_goal: null,
    };
  }
  const item = {
    id: `review-${r.id}`,
    type: turns.length > 0 ? "followup" : "from_review",
    knowledge_version_id: r.trace.knowledgeVersionId,
    turns,
    message: turn.userText,
    ...(expect ? { expect } : { review: { verdict: r.verdict, note: r.note, route: r.trace.route, contextComplete } }),
  };
  return { ready: expect !== null, item };
}
