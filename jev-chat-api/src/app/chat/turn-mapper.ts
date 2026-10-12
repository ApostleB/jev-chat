import { ErrorCodeSchema, RouteSchema, type ChatDoneEvent, type ChatErrorEvent, type ErrorCode, type Route, type Turn } from "@jev-chat/protocol";
import type { TurnRow } from "../../adapters/persistence/turn.repository";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "인증이 필요합니다.",
  FORBIDDEN: "권한이 없습니다.",
  PROTOCOL_UNSUPPORTED: "지원하지 않는 프로토콜 버전입니다. 화면을 새로고침하세요.",
  INVALID_INPUT: "요청 형식이 올바르지 않습니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
  QUEUE_FULL: "처리 대기 중인 질문이 많습니다. 잠시 후 다시 시도해주세요.",
  QUEUE_TIMEOUT: "처리 대기 시간이 초과되었습니다. 다시 시도해주세요.",
  JEV_UNAVAILABLE: "일시적인 문제로 답변을 만들지 못했습니다. 잠시 후 다시 시도해주세요.",
  RESTARTED: "서버가 재시작되어 처리하지 못했습니다. 다시 시도해주세요.",
  NOT_FOUND: "대상을 찾을 수 없습니다.",
  INTERNAL: "처리 중 오류가 발생했습니다. 다시 시도해주세요.",
};

/** 저장된 route가 프로토콜의 Route가 아님(데이터 손상). 호출자는 로그(이름만) 후 INTERNAL로 처리한다. */
export class CorruptRouteError extends Error {
  override name = "CorruptRouteError";
  constructor() {
    super("저장된 route 값이 올바르지 않습니다.");
  }
}

export function parseRoute(route: string | null): Route {
  const parsed = RouteSchema.safeParse(route);
  if (!parsed.success) throw new CorruptRouteError();
  return parsed.data;
}

function normalizeCode(code: string | null): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "INTERNAL";
}

function errorOf(row: TurnRow): { code: ErrorCode; retryable: boolean } {
  return { code: normalizeCode(row.errorCode), retryable: row.errorRetryable ?? false };
}

export function toProtocolTurn(row: TurnRow): Turn {
  const base = { turnId: row.id, turnSeq: row.turnSeq, clientMsgId: row.clientMsgId, userText: row.userText, status: row.status };
  if (row.status === "processing") return base;
  if (row.status === "failed") return { ...base, error: errorOf(row), ...(row.traceId ? { traceId: row.traceId } : {}) };
  return {
    ...base,
    assistantText: row.assistantText ?? "",
    route: parseRoute(row.route),
    sources: row.sources ?? [],
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(row.route === "error" ? { error: errorOf(row) } : {}),
  };
}

export function toDoneEvent(row: TurnRow, sessionId: string): ChatDoneEvent {
  return {
    sessionId,
    clientMsgId: row.clientMsgId,
    turnSeq: row.turnSeq,
    turnId: row.id,
    text: row.assistantText ?? "",
    route: parseRoute(row.route),
    sources: row.sources ?? [],
    traceId: row.traceId ?? "",
    ...(row.route === "error" ? { error: errorOf(row) } : {}),
  };
}

export function toErrorEvent(row: TurnRow, sessionId: string, message?: string): ChatErrorEvent {
  const { code, retryable } = errorOf(row);
  return { sessionId, clientMsgId: row.clientMsgId, turnSeq: row.turnSeq, code, retryable, message: message ?? ERROR_MESSAGES[code] };
}
