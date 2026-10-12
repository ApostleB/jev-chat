import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 회귀: 대기열 타이머가 unref되면 다른 핸들이 없는 프로세스(평가 CLI)가 pending Promise를 둔 채 조용히 종료한다.
describe("JevLimiter 프로세스 수준 회귀", () => {
  it("예산 때문에 대기열에 들어간 acquire가 처리되고 프로세스가 정상 출력 후 종료한다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "limiter-proc-"));
    const script = path.join(dir, "run.ts");
    const limiterPath = path.resolve(__dirname, "limiter.ts");
    writeFileSync(
      script,
      `import { JevLimiter } from ${JSON.stringify(limiterPath)};
const limiter = new JevLimiter({ maxConcurrent: 4, maxRequestsPerSecond: 1, maxTokensPerSecond: 1000000, maxWaitMs: 5000 });
async function main() {
const signal = new AbortController().signal;
const r1 = await limiter.acquire(1, signal);
r1();
const r2 = await limiter.acquire(1, signal);
r2();
  console.log("DONE");
}
main().catch((e) => { console.error(String(e)); process.exitCode = 1; });
`,
    );
    const tsx = path.resolve(__dirname, "../../../node_modules/.bin/tsx");
    const res = spawnSync(tsx, [script], { encoding: "utf8", timeout: 20_000 });
    expect(res.stdout.trim()).toBe("DONE");
    expect(res.status).toBe(0);
  }, 30_000);
});
