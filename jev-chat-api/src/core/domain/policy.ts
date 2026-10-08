import type { Policy } from "./types";

function deepFreeze<T>(o: T): Readonly<T> {
  for (const v of Object.values(o as object)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

export const DEFAULT_POLICY: Policy = deepFreeze({
  inScope: { block: 0.4, clarify: 0.6 },
  ambiguous: 0.7,
  faq: 0.8,
  relevance: { reference: 0.5, answer: 0.8 },
  helpdesk: 0.5,
  candidates: { faq: 5, chunk: 8 },
  context: { maxTurns: 2, assistantMaxChars: 300 },
  deadlines: { engineMs: 8000, queueMs: 10000, limiterMs: 3000, saveMs: 3000 },
});
