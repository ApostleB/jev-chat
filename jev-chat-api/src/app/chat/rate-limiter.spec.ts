import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rate-limiter";

describe("SlidingWindowRateLimiter", () => {
  it("창 안에서 limit개까지 허용, 초과 시 retryAfterMs", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(2, 60_000, () => t);
    expect(r.take("u").ok).toBe(true);
    t = 10_000;
    expect(r.take("u").ok).toBe(true);
    t = 20_000;
    expect(r.take("u")).toEqual({ ok: false, retryAfterMs: 40_000 });
  });
  it("키별로 독립", () => {
    const r = new SlidingWindowRateLimiter(1, 1000, () => 0);
    expect(r.take("a").ok).toBe(true);
    expect(r.take("b").ok).toBe(true);
    expect(r.take("a").ok).toBe(false);
  });
  it("창이 지나면 다시 허용", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(1, 1000, () => t);
    r.take("u");
    t = 1000;
    expect(r.take("u").ok).toBe(true);
  });
  it("거절된 시도는 기록하지 않는다", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(1, 1000, () => t);
    r.take("u");
    t = 500;
    r.take("u");
    t = 1000;
    expect(r.take("u").ok).toBe(true);
  });
});
