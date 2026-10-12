import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api-client";
import { DEFAULT_RETRY_DELAY_MS, MAX_RETRY_AFTER_MS, queryRetryOptions, retryDelay, shouldRetry } from "./query-retry";

const err = (status: number, retryAfterMs?: number) => new ApiRequestError(status, "INTERNAL", "x", retryAfterMs);

describe("shouldRetry / retryDelay", () => {
  it("401·403·404·400·409·422는 재시도하지 않는다", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(shouldRetry(0, err(s))).toBe(false);
  });
  it("429·503은 1회, 이후는 없음", () => {
    expect(shouldRetry(0, err(429))).toBe(true);
    expect(shouldRetry(1, err(429))).toBe(false);
    expect(shouldRetry(0, err(503, 100))).toBe(true);
  });
  it("retryAfterMs가 상한(30000) 초과면 재시도하지 않는다", () => {
    expect(shouldRetry(0, err(429, MAX_RETRY_AFTER_MS))).toBe(true);
    expect(shouldRetry(0, err(429, MAX_RETRY_AFTER_MS + 1))).toBe(false);
  });
  it("네트워크 오류·그 외 5xx는 1회", () => {
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(1, new TypeError("Failed to fetch"))).toBe(false);
    expect(shouldRetry(0, err(500))).toBe(true);
    expect(shouldRetry(0, err(502))).toBe(true);
  });
  it("지연: retryAfterMs 우선, 없으면 기본 1000", () => {
    expect(retryDelay(0, err(429, 5000))).toBe(5000);
    expect(retryDelay(0, err(503))).toBe(DEFAULT_RETRY_DELAY_MS);
    expect(retryDelay(0, new TypeError("x"))).toBe(1000);
  });
});

describe("QueryClient 통합(가짜 타이머)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const run = (e: unknown) => {
    const qc = new QueryClient({ defaultOptions: { queries: queryRetryOptions } });
    const fn = vi.fn(async () => {
      throw e;
    });
    const p = qc.fetchQuery({ queryKey: ["k"], queryFn: fn }).catch(() => {});
    return { fn, p };
  };

  it("429 + retryAfterMs=5000 → 5000ms 전 재요청 없음, 이후 1회", async () => {
    const { fn, p } = run(err(429, 5000));
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    await p;
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("retryAfterMs=60000 → 재시도 없음", async () => {
    const { fn, p } = run(err(429, 60000));
    await vi.advanceTimersByTimeAsync(120000);
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("401·403 재시도 없음", async () => {
    for (const s of [401, 403]) {
      const { fn, p } = run(err(s));
      await vi.advanceTimersByTimeAsync(10000);
      await p;
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
  it("503 재시도, 네트워크 오류 1회", async () => {
    for (const e of [err(503), new TypeError("Failed to fetch")]) {
      const { fn, p } = run(e);
      await vi.advanceTimersByTimeAsync(10000);
      await p;
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });
});
