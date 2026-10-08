import { z } from "zod";
import { INTENT_IDS } from "../../core";

const Prob = z.number().min(0).max(1);
const PosInt = z.number().int().positive();

// 문자열 길이는 UTF-16 코드 단위(String.length) 기준이며 DB 컬럼 길이와 맞춘다. [P8]
export const ManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  language: z.string().min(2),
  template_version: z.string().min(1),
  helpdesk: z.object({ phone: z.string().min(1), email: z.string().min(1), url: z.string().optional() }),
});

export const PolicySchema = z.object({
  in_scope: z.object({ block: Prob, clarify: Prob }).refine((v) => v.block <= v.clarify, "in_scope.block ≤ in_scope.clarify"),
  ambiguous: Prob,
  faq: Prob,
  relevance: z.object({ reference: Prob, answer: Prob }).refine((v) => v.reference <= v.answer, "relevance.reference ≤ relevance.answer"),
  helpdesk: Prob,
  candidates: z.object({ faq: PosInt.max(10), chunk: PosInt.max(12) }),
  // [P8] 대화 문맥은 축소하지 않으므로 안전한 상한을 둔다
  context: z.object({ max_turns: PosInt.max(3), assistant_max_chars: PosInt.max(500) }),
  // [P10] 제한기 대기(limiter_ms)는 서버 설정(JEV_LIMITER_WAIT_MS)이라 팩에 두지 않는다
  deadlines: z.object({ engine_ms: PosInt, queue_ms: PosInt, save_ms: PosInt.min(1000, "save_ms는 1000 이상(트랜잭션 대기+실행 분할 하한)") }).strict(),
});

export const IntentsSchema = z
  .array(z.object({ id: z.enum(INTENT_IDS), description: z.string().min(1) }))
  .refine((arr) => arr.length === INTENT_IDS.length && INTENT_IDS.every((id) => arr.some((a) => a.id === id)), {
    message: `intents는 ${INTENT_IDS.join(", ")} 6개를 정확히 한 번씩 포함해야 합니다.`,
  });

export const ChunkLineSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "id는 소문자·숫자·하이픈"),
  module: z.string().min(1).max(100),
  kind: z.enum(["regulation", "how_to"]),
  title: z.string().min(1).max(200),
  section: z.string().min(1).max(200),
  text: z.string().min(1).max(4000, "청크 본문은 4000자 이하(대화 문맥을 줄이지 않기 위한 상한)"),
  tags: z.array(z.string()).default([]),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const FaqLineSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
    .refine((id) => id !== "none", "FAQ id 'none'은 Jev 선택지 '정답 없음'으로 예약됨"),
  intent: z.enum(INTENT_IDS),
  summary: z.string().min(1).max(500),
  applies_when: z.string().min(1).max(1000),
  answer: z.string().min(1).max(2000),
  source_chunk_id: z.string().min(1).nullable().default(null),
  variants: z.array(z.string().min(1).max(1000)).min(1),
});
