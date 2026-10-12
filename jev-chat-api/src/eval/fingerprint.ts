import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface Fingerprint {
  packHash: string;
  holdoutHash: string;
  templateLang: string;
  optionOrder: string;
  templateVersion: string;
  model: string;
  policyHash: string;
  /** [N1] HEAD의 jev-chat-api/src 트리 해시 — 원장 커밋은 바꾸지 않는다 */
  codeTree: string;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const fileSha256 = async (path: string) => sha256(await readFile(path));
export const fingerprintKey = (fp: Fingerprint) => sha256(JSON.stringify(Object.entries(fp).sort()));

/**
 * [N1] 평가 대상 코드의 트리 해시. 원장(eval/holdout-ledger) 외의 변경이 있으면 throw.
 * 원장 기록·커밋은 src 트리를 바꾸지 않으므로 같은 RC의 재실행 지문이 유지된다.
 */
export function evalCodeTree(cwd: string, ledgerRel = "domain-pack/hanbit-erp/eval/holdout-ledger"): string {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ".", `:(exclude)${ledgerRel}`], { cwd, encoding: "utf8" }).trim();
  if (dirty) throw new Error("holdout은 원장 외 변경이 없는 상태에서만 실행할 수 있습니다.");
  return execFileSync("git", ["rev-parse", "HEAD:jev-chat-api/src"], { cwd: resolveRepoRoot(cwd), encoding: "utf8" }).trim();
}

function resolveRepoRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}
