import { ApiRequestError } from "./api-client";

export const DEFAULT_RETRY_DELAY_MS = 1000;
/** 서버가 이보다 오래 기다리라고 하면 자동 재시도하지 않고 사용자 재시도 UI에 맡긴다 */
export const MAX_RETRY_AFTER_MS = 30000;
const MAX_RETRIES = 1;

/** [F3] REST 재시도 판단은 status(429/503)와 retryAfterMs로 한다 [P6] */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (!(error instanceof ApiRequestError)) return true; // 네트워크 오류
  if (error.status === 429 || error.status === 503) return error.retryAfterMs === undefined || error.retryAfterMs <= MAX_RETRY_AFTER_MS;
  return error.status >= 500; // 그 외 4xx(401·403 등)와 비정상 2xx 응답은 재시도 무의미
}

export function retryDelay(_failureCount: number, error: unknown): number {
  if (error instanceof ApiRequestError && error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
  return DEFAULT_RETRY_DELAY_MS;
}

export const queryRetryOptions = { retry: shouldRetry, retryDelay, refetchOnWindowFocus: false } as const;
