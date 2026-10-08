import { describe, expect, it } from "vitest";
import { JevLimiter, LimiterRejectedError } from "./limiter";

const cfg = { maxConcurrent: 2, maxRequestsPerSecond: 100, maxTokensPerSecond: 1_000_000, maxWaitMs: 200 };
const live = () => new AbortController().signal;

describe("JevLimiter", () => {
  it("동시 실행 상한을 지킨다 — 슬롯이 반환되면 대기자가 진행", async () => {
    const limiter = new JevLimiter(cfg);
    const r1 = await limiter.acquire(10, live());
    const r2 = await limiter.acquire(10, live());
    let third = false;
    const p3 = limiter.acquire(10, live()).then((r) => {
      third = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(third).toBe(false);
    expect(limiter.stats()).toEqual({ active: 2, waiting: 1 });
    r1();
    (await p3)();
    expect(third).toBe(true);
    r2();
  });

  it("maxWaitMs를 넘기면 LimiterRejectedError", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 1, maxWaitMs: 40 });
    const r1 = await limiter.acquire(10, live());
    await expect(limiter.acquire(10, live())).rejects.toMatchObject({ reason: "timeout" });
    r1();
  });

  it("초당 요청 수를 지킨다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxRequestsPerSecond: 2, maxWaitMs: 50 });
    (await limiter.acquire(1, live()))();
    (await limiter.acquire(1, live()))();
    await expect(limiter.acquire(1, live())).rejects.toBeInstanceOf(LimiterRejectedError);
  });

  it("[P1] 첫 요청이라도 초당 토큰 예산보다 크면 즉시 oversized 거절", async () => {
    const limiter = new JevLimiter({ ...cfg, maxTokensPerSecond: 100 });
    await expect(limiter.acquire(101, live())).rejects.toMatchObject({ reason: "oversized" });
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("[P1] 예산과 정확히 같은 요청은 통과", async () => {
    const limiter = new JevLimiter({ ...cfg, maxTokensPerSecond: 100 });
    (await limiter.acquire(100, live()))();
  });

  it("[P1] 창이 만료된 직후에도 토큰 예산을 적용한다(가짜 시계)", async () => {
    let t = 0;
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxTokensPerSecond: 100, maxWaitMs: 50 }, () => t);
    (await limiter.acquire(90, live()))();
    t = 1000; // 첫 창 만료
    (await limiter.acquire(90, live()))(); // t=1000 창: 90 사용
    const p = limiter.acquire(20, live()); // 110 > 100 → 대기
    t = 1051; // 대기 기한(50ms)만 지나고 t=1000 창은 아직 유효 → timeout 거절
    await expect(p).rejects.toMatchObject({ reason: "timeout" });
  });

  it("초당 토큰 수를 지킨다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxTokensPerSecond: 100, maxWaitMs: 50 });
    (await limiter.acquire(80, live()))();
    await expect(limiter.acquire(30, live())).rejects.toBeInstanceOf(LimiterRejectedError);
  });

  it("1초 창이 지나면 다시 허용한다(가짜 시계)", async () => {
    let t = 0;
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxRequestsPerSecond: 1, maxWaitMs: 2000 }, () => t);
    (await limiter.acquire(1, live()))();
    const p = limiter.acquire(1, live());
    t = 1001;
    (await p)();
  });

  it("대기 중 abort되면 즉시 거절하고 대기열에서 빠진다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 1, maxWaitMs: 1000 });
    const r1 = await limiter.acquire(1, live());
    const ctrl = new AbortController();
    const p = limiter.acquire(1, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(limiter.stats().waiting).toBe(0);
    r1();
  });

  it("release를 두 번 불러도 슬롯은 한 번만 반환된다", async () => {
    const limiter = new JevLimiter(cfg);
    const r = await limiter.acquire(1, live());
    r();
    r();
    expect(limiter.stats().active).toBe(0);
  });
});
