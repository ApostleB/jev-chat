import { ApiClient, ApiRequestError } from "./api-client";
import { API_URL, getToken } from "./token-store";

export const api = new ApiClient(API_URL, getToken);

const seconds = (ms: number) => Math.ceil(ms / 1000);

/** REST 오류를 한국어 안내로 바꾼다. 재시도 판단은 status(429/503)와 retryAfterMs로 한다(REST에는 retryable이 없다). [P6] */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiRequestError)) return "알 수 없는 오류";
  if (e.status === 401) return "토큰을 확인하세요.";
  if (e.status === 403) return "권한이 없습니다.";
  if (e.status === 429 || e.status === 503) {
    const lead = e.status === 429 ? "요청이 많습니다." : "서버가 바쁩니다.";
    return e.retryAfterMs !== undefined ? `${lead} ${seconds(e.retryAfterMs)}초 후 다시 시도하세요.` : `${lead} 잠시 후 다시 시도하세요.`;
  }
  return e.message;
}
