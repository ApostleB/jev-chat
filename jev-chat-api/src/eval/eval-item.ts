import { z } from "zod";
import { INTENT_IDS } from "../core";

export const OutcomeSchema = z.enum(["ANSWER", "REFERENCE", "HOLD", "BLOCK", "ERROR"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const EVAL_TYPES = [
  "normal", "negation", "confusable", "out_of_scope", "smalltalk", "followup",
  "ambiguous", "injection", "number_date", "option_order", "from_review",
] as const;

const Ids = z.array(z.string().min(1)).refine((a) => new Set(a).size === a.length, "ID 중복");

export const EvalItemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    type: z.enum(EVAL_TYPES),
    turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1), sources: Ids.optional() })).default([]),
    message: z.string().min(1).max(1000),
    expect: z.object({
      intent: z.enum(INTENT_IDS).optional(),
      allowed_outcomes: z.array(OutcomeSchema).min(1),
      faq_ids: Ids.optional(),
      acceptable_chunk_ids: Ids.optional(),
      required_chunk_ids_any: Ids.optional(),
      attack_goal: z.union([z.null(), z.object({ faq_id: z.string() }), z.object({ outcome: OutcomeSchema })]).default(null),
    }),
  })
  .superRefine((item, ctx) => {
    const e = item.expect;
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    // turns: user로 시작, 엄격 교대, 짝수 길이, sources는 assistant에만
    if (item.turns.length % 2 !== 0) issue(["turns"], "turns는 user/assistant 쌍이어야 합니다.");
    item.turns.forEach((t, i) => {
      if (t.role !== (i % 2 === 0 ? "user" : "assistant")) issue(["turns", i], "turns는 user로 시작해 교대해야 합니다.");
      if (t.role === "user" && t.sources) issue(["turns", i, "sources"], "sources는 assistant 턴에만 둡니다.");
    });
    if (item.type === "injection" && e.attack_goal === null) issue(["expect", "attack_goal"], "injection 항목은 attack_goal이 필요합니다.");
    // [E7 재확인] injection도 ANSWER를 허용하면(정상 질문이 섞인 경우) 정답 라벨이 필요하다
    if (e.allowed_outcomes.includes("ANSWER")) {
      const hasFaq = (e.faq_ids?.length ?? 0) > 0;
      const hasChunks = (e.acceptable_chunk_ids?.length ?? 0) > 0 && (e.required_chunk_ids_any?.length ?? 0) > 0;
      if (!hasFaq && !hasChunks) issue(["expect"], "ANSWER를 허용하면 정답 라벨(faq_ids 또는 acceptable+required)이 필요합니다.");
    }
    if (e.required_chunk_ids_any && e.acceptable_chunk_ids) {
      const acc = new Set(e.acceptable_chunk_ids);
      if (!e.required_chunk_ids_any.every((id) => acc.has(id))) issue(["expect", "required_chunk_ids_any"], "required_chunk_ids_any는 acceptable_chunk_ids의 부분집합이어야 합니다.");
    }
    if (e.allowed_outcomes.includes("REFERENCE") && !(e.acceptable_chunk_ids?.length ?? 0)) {
      issue(["expect", "acceptable_chunk_ids"], "REFERENCE를 허용하면 acceptable_chunk_ids가 필요합니다.");
    }
  });
export type EvalItem = z.infer<typeof EvalItemSchema>;
