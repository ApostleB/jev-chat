import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { ConfiguredIoAdapter } from "./chat/io.adapter";
import { validateEnv } from "./config/env.schema";

async function bootstrap(): Promise<void> {
  const env = validateEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));
  app.useBodyParser("json", { limit: "8kb" });
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: false });
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

bootstrap().catch((e: unknown) => {
  // env 검증 실패 메시지에는 값이 포함되지 않는다(validateEnv가 보장)
  console.error(e instanceof Error ? e.message : "부팅 실패");
  process.exit(1);
});
