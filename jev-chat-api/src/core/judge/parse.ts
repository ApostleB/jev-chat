import { z } from "zod";
import { INTENT_IDS, type IntentId } from "../domain/types";
import type { ChoiceResult, TurnJudgment } from "./ports";

export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

const Prob = z.number().min(0).max(1);
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: Prob,
  probabilities: z.record(z.string(), Prob),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: Prob });

function fail(message: string): never {
  throw new JevResponseError(message);
}

function toChoice<T extends string>(raw: unknown, allowed: readonly T[], name: string): ChoiceResult<T> {
  const parsed = ChoiceAnswer.safeParse(raw);
  if (!parsed.success) fail(`${name}: choice 형식 아님`);
  const { choice, confidence, probabilities } = parsed.data;
  if (!(allowed as readonly string[]).includes(choice)) fail(`${name}: 허용되지 않은 선택지 ${choice}`);
  const probs = Object.fromEntries(allowed.map((k) => [k, probabilities[k] ?? 0])) as Record<T, number>;
  return { choice: choice as T, confidence, probabilities: probs };
}

function toNoul(raw: unknown, name: string): number {
  const parsed = NoulAnswer.safeParse(raw);
  if (!parsed.success) fail(`${name}: noul 형식 아님`);
  return parsed.data.noul;
}

function asRecord(answers: unknown): Record<string, unknown> {
  if (typeof answers !== "object" || answers === null) fail("answers가 객체가 아님");
  return answers as Record<string, unknown>;
}

export function parseTurnAnswers(answers: unknown, faqCandidateIds: string[]): TurnJudgment {
  const a = asRecord(answers);
  const intent = toChoice<IntentId>(a.intent, INTENT_IDS, "intent");
  const ambiguity = toNoul(a.ambiguous, "ambiguous");
  const faq = faqCandidateIds.length === 0 ? null : toChoice<string>(a.faq, [...faqCandidateIds, "none"], "faq");
  return { intent, ambiguity, faq };
}

export function parseRelevanceAnswer(answers: unknown): number {
  return toNoul(asRecord(answers).relevant, "relevant");
}
