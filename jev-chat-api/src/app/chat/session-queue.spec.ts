import { describe, expect, it } from "vitest";
import { SessionQueue } from "./session-queue";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SessionQueue", () => {
  it("withLock은 같은 세션의 임계 구역을 직렬화한다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    await Promise.all([
      q.withLock("s", async () => {
        log.push("a-start");
        await new Promise((r) => setTimeout(r, 10));
        log.push("a-end");
      }),
      q.withLock("s", async () => {
        log.push("b-start");
        log.push("b-end");
      }),
    ]);
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("withLock 안에서 예외가 나도 잠금이 풀린다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    await expect(q.withLock("s", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await q.withLock("s", async () => 1)).toBe(1);
  });

  it("슬롯은 capacity까지만 예약된다", () => {
    const q = new SessionQueue({ capacity: 2 });
    expect([q.tryReserve("s"), q.tryReserve("s"), q.tryReserve("s")]).toEqual([true, true, false]);
    q.release("s");
    expect(q.tryReserve("s")).toBe(true);
    expect(q.tryReserve("other")).toBe(true);
  });

  it("run은 세션별로 순차 실행하고 다른 세션은 병렬", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    let releaseFirst!: () => void;
    q.run("s", () => new Promise<void>((r) => { log.push("s1"); releaseFirst = r; }));
    q.run("s", async () => { log.push("s2"); });
    q.run("t", async () => { log.push("t1"); });
    await tick();
    expect(log).toEqual(["s1", "t1"]);
    releaseFirst();
    await tick();
    await tick();
    expect(log).toEqual(["s1", "t1", "s2"]);
  });

  it("run 작업이 실패해도 다음 작업이 실행된다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    q.run("s", async () => { throw new Error("boom"); });
    q.run("s", async () => { log.push("next"); });
    await tick();
    await tick();
    expect(log).toEqual(["next"]);
  });

  it("[M-3] run 작업 예외는 삼키지 않고 onError로 알린다(onError가 던져도 체인은 계속)", async () => {
    const seen: unknown[] = [];
    const q = new SessionQueue({ capacity: 5, onError: (e) => { seen.push(e); throw new Error("log down"); } });
    const log: string[] = [];
    q.run("s", async () => { throw new Error("boom"); });
    q.run("s", async () => { log.push("next"); });
    await tick();
    await tick();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("boom");
    expect(log).toEqual(["next"]);
  });
});
