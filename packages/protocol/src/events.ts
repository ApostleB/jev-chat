import { z } from "zod";
import { AckSchema, ErrorCodeSchema, MessageTextSchema, RouteSchema, UuidSchema, type Ack } from "./common";

const TurnSeqSchema = z.number().int().min(1);

export const SourceRefSchema = z.object({
  chunkId: z.string(),
  versionId: z.string(),
  contentHash: z.string(),
  title: z.string(),
  section: z.string(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const TurnStatusSchema = z.enum(["processing", "completed", "failed"]);

export const TurnSchema = z.object({
  turnId: z.string(),
  turnSeq: TurnSeqSchema,
  clientMsgId: UuidSchema,
  userText: z.string(),
  status: TurnStatusSchema,
  assistantText: z.string().optional(),
  route: RouteSchema.optional(),
  sources: z.array(SourceRefSchema).optional(),
  error: z.object({ code: ErrorCodeSchema, retryable: z.boolean() }).optional(),
  traceId: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

// ── C→S
export const SessionStartRequestSchema = z.object({
  sessionId: UuidSchema.optional(),
  beforeTurnSeq: TurnSeqSchema.optional(),
});
export type SessionStartRequest = z.infer<typeof SessionStartRequestSchema>;

export const SessionStartResponseSchema = z.object({
  sessionId: UuidSchema,
  turns: z.array(TurnSchema),
  hasMore: z.boolean(),
  nextBeforeTurnSeq: TurnSeqSchema.optional(),
});
export type SessionStartResponse = z.infer<typeof SessionStartResponseSchema>;

export const ChatSendRequestSchema = z.object({
  sessionId: UuidSchema,
  clientMsgId: UuidSchema,
  text: MessageTextSchema,
  retryOfTurnSeq: TurnSeqSchema.optional(),
});
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

export const ChatSendResponseSchema = z.object({
  turnId: z.string(),
  turnSeq: TurnSeqSchema,
  status: z.enum(["accepted", "duplicate"]),
});
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

// ── S→C
const TurnRefSchema = z.object({ sessionId: UuidSchema, clientMsgId: UuidSchema, turnSeq: TurnSeqSchema });

export const ChatStatusEventSchema = TurnRefSchema.extend({
  stage: z.enum(["queued", "judging", "answering"]),
});
export type ChatStatusEvent = z.infer<typeof ChatStatusEventSchema>;

export const ChatDoneEventSchema = TurnRefSchema.extend({
  turnId: z.string(),
  text: z.string(),
  route: RouteSchema,
  sources: z.array(SourceRefSchema),
  traceId: z.string(),
});
export type ChatDoneEvent = z.infer<typeof ChatDoneEventSchema>;

export const ChatErrorEventSchema = TurnRefSchema.extend({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ChatErrorEvent = z.infer<typeof ChatErrorEventSchema>;

// trace 본문 구조는 계획 2에서 확정한다. 프로토콜은 JSON 객체임만 보장한다.
export const ChatTraceEventSchema = z.object({
  traceId: z.string(),
  trace: z.record(z.string(), z.unknown()),
});
export type ChatTraceEvent = z.infer<typeof ChatTraceEventSchema>;

export const SessionStartAckSchema = AckSchema(SessionStartResponseSchema);
export const ChatSendAckSchema = AckSchema(ChatSendResponseSchema);

export interface ClientToServerEvents {
  "session:start": (req: SessionStartRequest, ack: (res: Ack<SessionStartResponse>) => void) => void;
  "chat:send": (req: ChatSendRequest, ack: (res: Ack<ChatSendResponse>) => void) => void;
}

export interface ServerToClientEvents {
  "chat:status": (e: ChatStatusEvent) => void;
  "chat:done": (e: ChatDoneEvent) => void;
  "chat:error": (e: ChatErrorEvent) => void;
  "chat:trace": (e: ChatTraceEvent) => void;
}
