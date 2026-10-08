import { describe, expect, it } from "vitest";
import { linkedController } from "./abort";

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
