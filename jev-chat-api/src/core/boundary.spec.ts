import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// pnpm --filter로 실행하면 cwd는 jev-chat-api 패키지 루트다.
const CORE_DIR = resolve(process.cwd(), "src/core");
const MODULES = String.raw`(@nestjs\/|@prisma\/|prisma["'\/]|socket\.io|@typesafe-ai\/)`;
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp(String.raw`\bfrom\s*["']${MODULES}`), reason: "정적 import/export from" },
  { pattern: new RegExp(String.raw`\bimport\s*\(\s*["']${MODULES}`), reason: "동적 import()" },
  { pattern: new RegExp(String.raw`\brequire\s*\(\s*["']${MODULES}`), reason: "require()" },
  { pattern: new RegExp(String.raw`\bimport\s*["']${MODULES}`), reason: "부수효과 import" },
  { pattern: /\bprocess\s*(\.|\[\s*["'])\s*env\b/, reason: "process.env" },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") && !full.endsWith(".spec.ts") ? [full] : [];
  });
}

describe("core 경계", () => {
  it("core 소스는 프레임워크·SDK·process.env에 의존하지 않는다", () => {
    const violations = walk(CORE_DIR).flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return FORBIDDEN.filter((f) => f.pattern.test(src)).map((f) => `${relative(CORE_DIR, file)}: ${f.reason}`);
    });
    expect(violations).toEqual([]);
  });
});

describe("경계 검사 패턴 자체 검증", () => {
  const hits = (src: string) => FORBIDDEN.some((f) => f.pattern.test(src));
  it.each([
    'import x from "@nestjs/common"',
    'export { y } from "@prisma/client"',
    'const m = await import("socket.io")',
    'require("@typesafe-ai/sdk")',
    'import "prisma/config"',
    'process["env"].X',
    "process.env.X",
  ])("위반으로 탐지: %s", (src) => {
    expect(hits(src)).toBe(true);
  });
  it.each(['import { z } from "zod"', 'import type { A } from "../domain/types"'])("정상 import는 통과: %s", (src) => {
    expect(hits(src)).toBe(false);
  });
});
