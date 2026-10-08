import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./policy";

describe("DEFAULT_POLICY", () => {
  it("중첩 객체까지 깊게 동결된다", () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.deadlines)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.inScope)).toBe(true);
  });
  it("중첩 값 대입은 strict mode에서 TypeError", () => {
    "use strict";
    expect(() => {
      (DEFAULT_POLICY.deadlines as { engineMs: number }).engineMs = 1;
    }).toThrow(TypeError);
  });
});
