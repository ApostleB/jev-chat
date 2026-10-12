import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../core";
import { applyPolicyOverride } from "./policy-override";

describe("applyPolicyOverride [E8]", () => {
  it("깊은 병합: 지정한 값만 바뀌고 나머지는 유지, 해시 기록", () => {
    const r = applyPolicyOverride(DEFAULT_POLICY, { faq: 0.75, relevance: { answer: 0.85 } });
    expect(r.policy.faq).toBe(0.75);
    expect(r.policy.relevance).toEqual({ reference: DEFAULT_POLICY.relevance.reference, answer: 0.85 });
    expect(r.policy.deadlines).toEqual(DEFAULT_POLICY.deadlines);
    expect(r.overrideHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("덮어쓰기가 없으면 해시 null", () => {
    expect(applyPolicyOverride(DEFAULT_POLICY, undefined)).toEqual({ policy: DEFAULT_POLICY, overrideHash: null });
  });
  it("모르는 키·범위 밖 값·불변식 위반 거부", () => {
    expect(() => applyPolicyOverride(DEFAULT_POLICY, { faqq: 0.7 })).toThrow();
    expect(() => applyPolicyOverride(DEFAULT_POLICY, { faq: 1.2 })).toThrow();
    expect(() => applyPolicyOverride(DEFAULT_POLICY, { inScope: { block: 0.7 } })).toThrow(/block/);
  });
});
