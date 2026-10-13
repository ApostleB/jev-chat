import { z } from "zod";

const Num = z.number().finite();
const Candidate = z.object({
  kind: z.enum(["faq", "chunk"]),
  id: z.string(),
  bm25Rank: Num,
  relevance: Num.optional(),
  faqProb: Num.optional(),
  status: z.string().optional(),
});
const TraceSchema = z.object({
  route: z.string(),
  bStatus: z.string(),
  intent: z.string().nullable().optional(),
  intentProbs: z.record(z.string(), Num).nullable().optional(),
  inScope: Num.nullable().optional(),
  ambiguity: Num.nullable().optional(),
  manipulation: Num.nullable().optional(),
  faqChoice: z.string().nullable().optional(),
  faqProb: Num.nullable().optional(),
  totalInputTokens: Num.optional(),
  latencyMs: z.object({ retrieval: Num, turn: Num.nullable(), relevance: Num.nullable(), total: Num }).optional(),
  candidates: z.array(Candidate).default([]),
});

export interface TraceView {
  route: string;
  bStatus: string;
  intent: string | null;
  intents: { id: string; prob: number }[];
  inScope: number | null;
  ambiguity: number | null;
  manipulation: number | null;
  faqChoice: string | null;
  faqCandidates: { id: string; rank: number; prob: number | null }[];
  chunkCandidates: { id: string; rank: number; relevance: number | null; status: string }[];
  latency: { retrieval: number; turn: number | null; relevance: number | null; total: number } | null;
  totalInputTokens: number | null;
}

export function toTraceView(raw: unknown): TraceView | null {
  const p = TraceSchema.safeParse(raw);
  if (!p.success) return null;
  const t = p.data;
  return {
    route: t.route,
    bStatus: t.bStatus,
    intent: t.intent ?? null,
    intents: Object.entries(t.intentProbs ?? {}).map(([id, prob]) => ({ id, prob })).sort((a, b) => b.prob - a.prob),
    inScope: t.inScope ?? null,
    ambiguity: t.ambiguity ?? null,
    manipulation: t.manipulation ?? null,
    faqChoice: t.faqChoice ?? null,
    faqCandidates: t.candidates.filter((c) => c.kind === "faq").map((c) => ({ id: c.id, rank: c.bm25Rank, prob: c.faqProb ?? null })),
    chunkCandidates: t.candidates.filter((c) => c.kind === "chunk").map((c) => ({ id: c.id, rank: c.bm25Rank, relevance: c.relevance ?? null, status: c.status ?? "-" })),
    latency: t.latencyMs ?? null,
    totalInputTokens: t.totalInputTokens ?? null,
  };
}
