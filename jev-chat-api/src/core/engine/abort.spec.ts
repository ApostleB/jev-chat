import { afterEach, describe, expect, it } from "vitest";
import { linkedController, raceWithAbort } from "./abort";

describe("linkedController", () => {
  it("부모가 abort되면 자식도 abort된다(reason 전달)", () => {
    const parent = new AbortController();
    const child = linkedController(parent.signal);
    expect(child.signal.aborted).toBe(false);
    parent.abort(new Error("p"));
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toBe("p");
  });
  it("자식이 abort되어도 부모는 그대로다", () => {
    const parent = new AbortController();
    const child = linkedController(parent.signal);
    child.abort();
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });
  it("이미 abort된 부모면 자식도 처음부터 abort", () => {
    const parent = new AbortController();
    parent.abort();
    expect(linkedController(parent.signal).signal.aborted).toBe(true);
  });
  it("같은 부모로 1000개를 만들어도 부모 abort 시 모두 abort된다", () => {
    const parent = new AbortController();
    const children = Array.from({ length: 1000 }, () => linkedController(parent.signal));
    parent.abort();
    expect(children.every((c) => c.signal.aborted)).toBe(true);
  });
});

describe("raceWithAbort", () => {
  const listeners: ((e: unknown) => void)[] = [];
  afterEach(() => {
    for (const l of listeners.splice(0)) process.off("unhandledRejection", l);
  });

  it("이미 abort된 signal이면 onAbort 값을 반환하고 버려진 promise의 rejection은 unhandled가 되지 않는다", async () => {
    const seen: unknown[] = [];
    const l = (e: unknown) => seen.push(e);
    listeners.push(l);
    process.on("unhandledRejection", l);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await raceWithAbort(Promise.reject(new Error("x")), ctrl.signal, () => "cancelled");
    expect(r).toBe("cancelled");
    await new Promise((res) => setTimeout(res, 10));
    expect(seen).toEqual([]);
  });

  it("abort 전에는 원 promise의 결과를, abort 후에는 onAbort 값을 돌려준다", async () => {
    expect(await raceWithAbort(Promise.resolve(1), new AbortController().signal, () => 2)).toBe(1);
    const ctrl = new AbortController();
    const p = raceWithAbort(new Promise<number>(() => {}), ctrl.signal, () => 2);
    ctrl.abort();
    expect(await p).toBe(2);
  });
});
