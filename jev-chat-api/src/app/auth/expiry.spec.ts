import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armExpiry, MAX_TIMER_MS } from "./expiry";

describe("armExpiry", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("expiresAt이 없으면 만료 없음(타이머 없음)", () => {
    const onExpire = vi.fn();
    const r = armExpiry(undefined, onExpire);
    expect(r).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "123", null, {}])("숫자가 아니거나 유한하지 않으면 인증 실패: %s", (bad) => {
    expect(armExpiry(bad, vi.fn())).toEqual({ ok: false, reason: "invalid" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 999_999, 1_000_000])("남은 시간이 0 이하면 만료로 거부: %s", (at) => {
    expect(armExpiry(at, vi.fn())).toEqual({ ok: false, reason: "expired" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("남은 시간이 지나면 onExpire", () => {
    const onExpire = vi.fn();
    armExpiry(1_000_500, onExpire);
    vi.advanceTimersByTime(499);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("2^31-1ms 초과는 바로 끊지 않고 상한으로 끊어 재무장한다", () => {
    const onExpire = vi.fn();
    const remaining = MAX_TIMER_MS + 5_000;
    armExpiry(1_000_000 + remaining, onExpire);
    vi.advanceTimersByTime(1); // setTimeout 오버플로 시 1ms로 즉시 끊기던 문제
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS - 1);
    expect(onExpire).not.toHaveBeenCalled(); // 첫 타이머 소진, 재무장됨
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("cancel하면 타이머가 남지 않고 재무장도 멈춘다", () => {
    const onExpire = vi.fn();
    const r = armExpiry(1_000_000 + MAX_TIMER_MS + 5_000, onExpire);
    if (!r.ok) throw new Error("armed");
    r.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MAX_TIMER_MS + 10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
