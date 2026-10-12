import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evalCodeTree, type Fingerprint } from "./fingerprint";
import { decideHoldout, HoldoutLedger, type HoldoutResult } from "./holdout-lock";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
const LEDGER_REL = "domain-pack/hanbit-erp/eval/holdout-ledger";

/** 임시 저장소(실제 저장소 상태는 건드리지 않는다): jev-chat-api/src/x.ts 와 가짜 holdout/freeze를 커밋 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "flow-"));
  git(root, "init", "-q");
  const api = join(root, "jev-chat-api");
  mkdirSync(join(api, "src"), { recursive: true });
  mkdirSync(join(api, "domain-pack/hanbit-erp/eval"), { recursive: true });
  writeFileSync(join(api, "src/x.ts"), "export const x = 1;\n");
  writeFileSync(join(api, "domain-pack/hanbit-erp/eval/holdout.jsonl"), "{}\n");
  writeFileSync(join(api, "domain-pack/hanbit-erp/eval/holdout.freeze.json"), "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, api };
}
const fpWith = (codeTree: string): Fingerprint => ({ packHash: "p", holdoutHash: "h", templateLang: "en", optionOrder: "normal", templateVersion: "v1-en", model: "m", policyHash: "q", codeTree });
const result = (fingerprint: Fingerprint): HoldoutResult => ({ rc: "rc1", fingerprint, overallPass: false, rates: {}, providerFailedIds: ["a"], scoresFile: "s", scoresSha256: "x", finishedAt: "t" });

describe("holdout 전체 흐름 (임시 git 저장소) [N1]", () => {
  it("원장만 커밋해도 코드 트리 지문이 같아 재실행이 허용된다", async () => {
    const { root, api } = makeRepo();
    const tree = evalCodeTree(api);
    const fp = fpWith(tree);
    const ledger = new HoldoutLedger(join(api, LEDGER_REL));
    await ledger.reserve("rc1", fp);
    await ledger.complete("rc1", result(fp));
    // 원장 파일은 untracked 상태여도 dirty로 보지 않는다
    expect(evalCodeTree(api)).toBe(tree);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "ledger");
    const after = evalCodeTree(api);
    expect(after).toBe(tree);
    expect(decideHoldout(await ledger.status("rc1"), "rerun", null, (await ledger.result("rc1"))!, fpWith(after))).toEqual({ allowed: true });
  });

  it("src를 바꿔 커밋하면 지문이 달라 재실행이 거부된다", async () => {
    const { root, api } = makeRepo();
    const fp = fpWith(evalCodeTree(api));
    const ledger = new HoldoutLedger(join(api, LEDGER_REL));
    await ledger.reserve("rc1", fp);
    await ledger.complete("rc1", result(fp));
    writeFileSync(join(api, "src/x.ts"), "export const x = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");
    const changed = evalCodeTree(api);
    expect(changed).not.toBe(fp.codeTree);
    expect(decideHoldout(await ledger.status("rc1"), "rerun", null, (await ledger.result("rc1"))!, fpWith(changed))).toMatchObject({ allowed: false });
  });

  it("원장 외 파일을 수정만 해도(미커밋) evalCodeTree가 throw한다", () => {
    const { api } = makeRepo();
    writeFileSync(join(api, "src/x.ts"), "export const x = 3;\n");
    expect(() => evalCodeTree(api)).toThrow(/원장 외 변경/);
    const { api: api2 } = makeRepo();
    writeFileSync(join(api2, "src/new.ts"), "export {};\n"); // untracked 도 dirty
    expect(() => evalCodeTree(api2)).toThrow(/원장 외 변경/);
  });
});
