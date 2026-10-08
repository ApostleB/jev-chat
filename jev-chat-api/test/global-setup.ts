import { execSync } from "node:child_process";

/** TEST_DATABASE_URL이 있으면 테스트 DB에 마이그레이션을 적용한다. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  if (!/_test(\?|$)/.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL의 database 이름은 _test로 끝나야 합니다(개발 DB 보호).");
  }
  execSync("pnpm prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
