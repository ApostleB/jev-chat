import "reflect-metadata";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Judge } from "../../core";
import { loadDomainPack } from "../../adapters/knowledge/pack-loader";
import { KnowledgeRepository } from "../../adapters/persistence/knowledge.repository";
import { createPrismaClient, dbConfigFromUrl, resetTestDb } from "../../adapters/persistence/prisma";
import type { AuthProvider } from "../auth/auth.types";
import { AUTH_PROVIDER } from "../auth/auth.types";
import { AppModule } from "../app.module";
import { ConfiguredIoAdapter } from "../chat/io.adapter";
import { validateEnv } from "../config/env.schema";
import { JUDGE } from "../jev.module";

export const MINI_PACK = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

/** TEST_DATABASE_URL 필수. 미니 팩을 import하고 Judge·AuthProvider를 바꿔 끼운 실제 앱을 띄운다. */
export async function createTestApp(opts: { judge: Judge; auth: AuthProvider }): Promise<{ app: INestApplication; url: string; close: () => Promise<void> }> {
  const db = dbConfigFromUrl(process.env.TEST_DATABASE_URL!);
  const prisma = createPrismaClient(db);
  await resetTestDb(prisma);
  await new KnowledgeRepository(prisma).importPack(await loadDomainPack(MINI_PACK));
  await prisma.$disconnect();

  const env = validateEnv({
    NODE_ENV: "test", TYPESAFE_API_KEY: "unused", DB_HOST: db.host, DB_PORT: String(db.port), DB_USER: db.user,
    DB_PASSWORD: db.password, DB_NAME: db.database, AUTH_MODE: "dev", DEV_ACCESS_TOKEN: "t".repeat(32), CORS_ORIGINS: "http://localhost:5173",
  });
  const { Test } = await import("@nestjs/testing");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(JUDGE).useValue(opts.judge)
    .overrideProvider(AUTH_PROVIDER).useValue(opts.auth)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.useBodyParser("json", { limit: "8kb" }); // [B9] main.ts와 동일
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
  await app.listen(0);
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  return { app, url, close: () => app.close() };
}
