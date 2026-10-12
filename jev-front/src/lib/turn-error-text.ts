import type { ErrorCode } from "@jev-chat/protocol";

/** [S3] protocol ErrorCode별 한국어 안내. Record<ErrorCode, …>라 코드가 늘면 타입 오류로 알려준다. */
const TEXT: Record<ErrorCode, string> = {
  UNAUTHORIZED: "인증에 실패했습니다. 접속 토큰을 확인하세요.",
  FORBIDDEN: "이 작업을 할 권한이 없습니다.",
  PROTOCOL_UNSUPPORTED: "서버와 화면의 버전이 맞지 않습니다. 화면을 새로고침하세요.",
  INVALID_INPUT: "요청 내용이 올바르지 않습니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
  QUEUE_FULL: "대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
  QUEUE_TIMEOUT: "대기 시간이 길어져 요청이 취소되었습니다.",
  JEV_UNAVAILABLE: "판단 엔진에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  RESTARTED: "서버가 다시 시작되어 처리가 중단되었습니다.",
  NOT_FOUND: "요청한 대화나 항목을 찾을 수 없습니다.",
  INTERNAL: "서버 내부 오류가 발생했습니다.",
};

export function turnErrorText(code: string): string {
  return Object.hasOwn(TEXT, code) ? TEXT[code as ErrorCode] : `처리 중 오류가 발생했습니다. (${code})`;
}
