import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// pnpm --filter로 실행하면 cwd는 jev-chat-api 패키지 루트다.
const CORE_DIR = resolve(process.cwd(), "src/core");
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /from\s+["']@nestjs\//, reason: "NestJS" },
  { pattern: /from\s+["']@prisma\//, reason: "Prisma" },
  { pattern: /from\s+["']prisma["']/, reason: "Prisma" },
  { pattern: /from\s+["']socket\.io/, reason: "Socket.IO" },
  { pattern: /from\s+["']@typesafe-ai\//, reason: "TypeSafe SDK" },
  { pattern: /process\.env/, reason: "process.env" },
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
