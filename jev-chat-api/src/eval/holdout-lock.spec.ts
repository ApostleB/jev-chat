import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideHoldout, HoldoutLedger, mergeRerun, type HoldoutResult } from "./holdout-lock";
import type { Fingerprint } from "./fingerprint";
import type { ItemScore } from "./score";

const fp = (o: Partial<Fingerprint> = {}): Fingerprint => ({
  packHash: "p", holdoutHash: "h", templateLang: "en", optionOrder: "normal", templateVersion: "v1-en", model: "jev-1.13.0", policyHash: "q", codeTree: "c", ...o,
});
const dir = () => mkdtempSync(join(tmpdir(), "ledger-"));
const result = (o: Partial<HoldoutResult> = {}): HoldoutResult => ({
  rc: "rc1", fingerprint: fp(), overallPass: false, rates: {}, providerFailedIds: ["a"], scoresFile: "x", scoresSha256: "s", finishedAt: "t", ...o,
});

describe("HoldoutLedger [E6]", () => {
  it("예약은 원자적: 같은 RC 두 번째 예약은 거부, 동시 예약도 하나만 성공", async () => {
    const l = new HoldoutLedger(dir());
    const r = await Promise.allSettled([l.reserve("rc1", fp()), l.reserve("rc1", fp())]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await expect(l.reserve("rc1", fp())).rejects.toThrow();
    expect(await l.status("rc1")).toBe("started");
  });
  it("[E6] 같은 지문으로 다른 RC 이름을 동시에 예약해도 하나만 성공", async () => {
    const l = new HoldoutLedger(dir());
    const r = await Promise.allSettled([l.reserve("rc-a", fp()), l.reserve("rc-b", fp())]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("[N1] 원장 기록 후에도 같은 지문으로 재실행 결정이 허용된다(지문에 커밋 해시 없음)", async () => {
    const l = new HoldoutLedger(dir());
    await l.reserve("rc1", fp());
    await l.complete("rc1", result());
    expect(decideHoldout(await l.status("rc1"), "rerun", null, (await l.result("rc1"))!, fp())).toEqual({ allowed: true });
  });

  it("완료·재실행 상태 전이와 지문 검색", async () => {
    const l = new HoldoutLedger(dir());
    await l.reserve("rc1", fp());
    await l.complete("rc1", result());
    expect(await l.status("rc1")).toBe("completed");
    expect(await l.findByFingerprint(fp())).toBe("rc1");
    await l.reserveRerun("rc1", fp());
    await expect(l.reserveRerun("rc1", fp())).rejects.toThrow();
  });
});

describe("decideHoldout", () => {
  it("첫 실행: 미사용 RC + 같은 지문의 다른 RC 없음일 때만", () => {
    expect(decideHoldout("none", "first", null)).toEqual({ allowed: true });
    expect(decideHoldout("started", "first", null)).toMatchObject({ allowed: false }); // 중단된 실행
    expect(decideHoldout("none", "first", "rc0")).toMatchObject({ allowed: false }); // 이름만 바꾼 반복
  });
  it("재실행: 완료 + 재실행 없음 + provider 실패 있음 + 지문 동일", () => {
    expect(decideHoldout("completed", "rerun", null, result(), fp())).toEqual({ allowed: true });
    expect(decideHoldout("rerun-started", "rerun", null, result(), fp())).toMatchObject({ allowed: false });
    expect(decideHoldout("completed", "rerun", null, result({ providerFailedIds: [] }), fp())).toMatchObject({ allowed: false });
    expect(decideHoldout("completed", "rerun", null, result(), fp({ codeTree: "other" }))).toMatchObject({ allowed: false });
  });
});

describe("mergeRerun [E5]", () => {
  const s = (id: string, failure: ItemScore["failure"], wrong = false) => ({ id, failure, wrongAnswer: wrong }) as ItemScore;
  it("허용된 provider 실패 ID만 교체하고 원래의 오답·내부 실패는 유지", () => {
    const merged = mergeRerun([s("a", "provider"), s("b", "internal"), s("c", "none", true)], [s("a", "none"), s("b", "none")], ["a"]);
    expect(merged.map((x) => [x.id, x.failure, x.wrongAnswer])).toEqual([["a", "none", false], ["b", "internal", false], ["c", "none", true]]);
  });
});
