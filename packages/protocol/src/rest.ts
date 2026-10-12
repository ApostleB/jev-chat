import { z } from "zod";
import { ErrorCodeSchema, RouteSchema } from "./common";

export function PageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const ApiErrorSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string(), retryAfterMs: z.number().int().nonnegative().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  turnCount: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const VerdictSchema = z.enum(["correct", "wrong", "partial"]);

export const ReviewRequestSchema = z.object({
  verdict: VerdictSchema,
  expectedIntent: z.string().max(30).optional(),
  expectedFaqId: z.string().max(100).optional(),
  expectedChunkIds: z.array(z.string().max(100)).max(20).optional(),
  note: z.string().max(2000).optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewSchema = ReviewRequestSchema.extend({ id: z.string(), reviewerId: z.string(), createdAt: z.string() });
export type Review = z.infer<typeof ReviewSchema>;

export const TraceDetailSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  route: RouteSchema,
  createdAt: z.string(),
  /** core TraceRecord(JSON) 원본 */
  data: z.record(z.string(), z.unknown()),
  reviews: z.array(ReviewSchema),
});
export type TraceDetail = z.infer<typeof TraceDetailSchema>;

export const ReviewQueueItemSchema = z.object({
  traceId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  userText: z.string(),
  assistantText: z.string().nullable(),
  route: RouteSchema,
  intent: z.string().nullable(),
  faqProb: z.number().nullable(),
  reviewed: z.boolean(),
  createdAt: z.string(),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const AdminConfigSchema = z.object({
  knowledgeVersionId: z.string().nullable(),
  packName: z.string().nullable(),
  packVersion: z.string().nullable(),
  model: z.string(),
  templateVersion: z.string(),
  policy: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export const KnowledgeChunkItemSchema = z.object({ id: z.string(), module: z.string(), kind: z.string(), title: z.string(), section: z.string(), text: z.string() });
export const KnowledgeFaqItemSchema = z.object({ id: z.string(), intent: z.string(), summary: z.string(), answer: z.string(), sourceChunkId: z.string().nullable(), variants: z.array(z.string()) });
export type KnowledgeChunkItem = z.infer<typeof KnowledgeChunkItemSchema>;
export type KnowledgeFaqItem = z.infer<typeof KnowledgeFaqItemSchema>;

export const ReloadResponseSchema = z.object({ versionId: z.string(), changed: z.boolean() });
export type ReloadResponse = z.infer<typeof ReloadResponseSchema>;
