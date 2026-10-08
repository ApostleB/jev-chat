import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbConfigFromUrl } from "../adapters/persistence/prisma";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.schema";

const url = process.env.TEST_DATABASE_URL;

describe.runIf(url)("앱 부팅 (통합)", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const db = dbConfigFromUrl(url!);
    const env = validateEnv({
      NODE_ENV: "test",
      TYPESAFE_API_KEY: "test-key-not-used",
      DB_HOST: db.host,
      DB_PORT: String(db.port),
      DB_USER: db.user,
      DB_PASSWORD: db.password,
      DB_NAME: db.database,
      AUTH_MODE: "dev",
      DEV_ACCESS_TOKEN: "t".repeat(32),
    });
    app = await NestFactory.create(AppModule.forRoot(env), { logger: false });
    await app.listen(0);
    base = await app.getUrl();
  });
  afterAll(async () => app?.close());

  it("GET /api/health → 200 {status:ok} (전체 DI 그래프 부팅 포함)", async () => {
    const res = await fetch(`${base.replace("[::1]", "127.0.0.1")}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
