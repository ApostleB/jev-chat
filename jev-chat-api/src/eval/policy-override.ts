import { createHash } from "node:crypto";
import { z } from "zod";
import type { Policy } from "../core";

const P = z.number().min(0).max(1);
const N = z.number().int().positive();

/** camelCase 깊은 부분 정책. 모르는 키는 거부한다. */
export const PolicyOverrideSchema = z
  .object({
    inScope: z.object({ block: P, clarify: P }).partial().strict(),
    ambiguous: P,
    manipulation: P,
    faq: P,
    relevance: z.object({ reference: P, answer: P }).partial().strict(),
    helpdesk: P,
    candidates: z.object({ faq: N.max(10), chunk: N.max(12) }).partial().strict(),
    context: z.object({ maxTurns: N.max(3), assistantMaxChars: N.max(500) }).partial().strict(),
  })
  .partial()
  .strict();

export function applyPolicyOverride(base: Policy, raw: unknown): { policy: Policy; overrideHash: string | null } {
  if (raw === undefined || raw === null) return { policy: base, overrideHash: null };
  const o = PolicyOverrideSchema.parse(raw);
  const policy: Policy = {
    ...base,
    ...(o.ambiguous !== undefined ? { ambiguous: o.ambiguous } : {}),
    ...(o.manipulation !== undefined ? { manipulation: o.manipulation } : {}),
    ...(o.faq !== undefined ? { faq: o.faq } : {}),
    ...(o.helpdesk !== undefined ? { helpdesk: o.helpdesk } : {}),
    inScope: { ...base.inScope, ...o.inScope },
    relevance: { ...base.relevance, ...o.relevance },
    candidates: { ...base.candidates, ...o.candidates },
    context: { ...base.context, ...o.context },
    deadlines: { ...base.deadlines },
  };
  if (policy.inScope.block > policy.inScope.clarify) throw new Error("inScope.block은 inScope.clarify 이하여야 합니다.");
  if (policy.relevance.reference > policy.relevance.answer) throw new Error("relevance.reference는 relevance.answer 이하여야 합니다.");
  const overrideHash = createHash("sha256").update(JSON.stringify(o)).digest("hex");
  return { policy, overrideHash };
}
