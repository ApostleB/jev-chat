import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const probe = resolve(__dirname, "../../../test/probes/linked-controller-gc.probe.ts");

describe("linkedController 수명 (Codex T1)", () => {
  it("반환된 signal만 쥐고 GC가 반복돼도 부모 타임아웃이 1초 안에 전파된다", () => {
    expect(() => execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", probe], { timeout: 10_000, stdio: "pipe" })).not.toThrow();
  });
});
