import "dotenv/config";
import { defineConfig } from "prisma/config";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_PORT = "3306", DB_USER, DB_PASSWORD = "", DB_NAME } = process.env;
  if (DB_HOST && DB_USER && DB_NAME) {
    return `mysql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  }
  // prisma generate처럼 DB 접속이 필요 없는 명령을 위한 자리표시자
  return "mysql://placeholder:placeholder@127.0.0.1:3306/placeholder";
}

/**
 * prisma migrate dev의 shadow database. SHADOW_DATABASE_URL이 있으면 그 값,
 * 없으면 DB_* 값으로 조립하되 database 이름만 jev_chat_shadow. 조립할 수 없으면 생략한다.
 */
function shadowDatabaseUrl(): string | undefined {
  if (process.env.SHADOW_DATABASE_URL) return process.env.SHADOW_DATABASE_URL;
  const { DB_HOST, DB_PORT = "3306", DB_USER, DB_PASSWORD = "" } = process.env;
  if (DB_HOST && DB_USER) {
    return `mysql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/jev_chat_shadow`;
  }
  return undefined;
}

const shadow = shadowDatabaseUrl();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl(), ...(shadow ? { shadowDatabaseUrl: shadow } : {}) },
});
