import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export const MAX_PAYLOAD_BYTES = 8192;
export const MAX_TEXT_CODEPOINTS = 1000;

export const UuidSchema = z.uuid();

export const MessageTextSchema = z
  .string()
  .trim()
  .refine((s) => [...s].length >= 1, { message: "빈 메시지는 보낼 수 없습니다." })
  .refine((s) => [...s].length <= MAX_TEXT_CODEPOINTS, { message: `메시지는 ${MAX_TEXT_CODEPOINTS}자 이하여야 합니다.` });

export const RouteSchema = z.enum(["faq", "extractive", "reference", "clarify", "blocked", "fallback", "error"]);
export type Route = z.infer<typeof RouteSchema>;

export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PROTOCOL_UNSUPPORTED",
  "INVALID_INPUT",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "QUEUE_TIMEOUT",
  "JEV_UNAVAILABLE",
  "RESTARTED",
  "NOT_FOUND",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export function AckSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ErrorPayloadSchema }),
  ]);
}
export type Ack<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };

export function isWithinPayloadLimit(value: unknown): boolean {
  const json = JSON.stringify(value) ?? "";
  return new TextEncoder().encode(json).byteLength <= MAX_PAYLOAD_BYTES;
}
