import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runCli } from "./run-cli";

function fakeProc() {
  const ee = new EventEmitter();
  const errs: string[] = [];
  const proc = Object.assign(ee, { exitCode: undefined as number | undefined, stderr: { write: (s: string) => (errs.push(s), true) } });
  return { proc, errs };
}
const tick = () => new Promise((r) => setImmediate(r));

describe("runCli", () => {
  it("resolve: exitCode = 반환값", async () => {
    const { proc } = fakeProc();
    await runCli(async () => 2, proc);
    expect(proc.exitCode).toBe(2);
  });
  it("reject: 메시지를 stderr에 쓰고 exitCode 1", async () => {
    const { proc, errs } = fakeProc();
    await runCli(async () => { throw new Error("boom"); }, proc);
    expect(proc.exitCode).toBe(1);
    expect(errs.join("")).toContain("boom");
  });
  it("미settle 상태에서 beforeExit: 오류 메시지 + exitCode 1", async () => {
    const { proc, errs } = fakeProc();
    void runCli(() => new Promise<number>(() => {}), proc);
    await tick();
    proc.emit("beforeExit", 0);
    expect(proc.exitCode).toBe(1);
    expect(errs.join("")).toContain("이벤트 루프가 비었습니다");
  });
  it("settle 후 beforeExit는 exitCode를 덮어쓰지 않는다", async () => {
    const { proc, errs } = fakeProc();
    await runCli(async () => 0, proc);
    proc.emit("beforeExit", 0);
    expect(proc.exitCode).toBe(0);
    expect(errs).toEqual([]);
  });
});
