import { Global, Logger, Module } from "@nestjs/common";
import type { Judge } from "../core";
import { JevLimiter } from "../adapters/jev/limiter";
import { SdkJevTransport } from "../adapters/jev/sdk-transport";
import type { JevTransport } from "../adapters/jev/transport";
import { TypesafeJudge } from "../adapters/jev/typesafe-judge";
import { ENV, type Env } from "./config/env.schema";

export const JEV_TRANSPORT = Symbol("JEV_TRANSPORT");
export const JUDGE = Symbol("JUDGE");

@Global()
@Module({
  providers: [
    {
      provide: JevLimiter,
      inject: [ENV],
      useFactory: (env: Env) =>
        new JevLimiter({
          maxConcurrent: env.JEV_MAX_CONCURRENT,
          maxRequestsPerSecond: env.JEV_MAX_RPS,
          maxTokensPerSecond: env.JEV_MAX_TPS,
          maxWaitMs: env.JEV_LIMITER_WAIT_MS,
        }),
    },
    {
      provide: JEV_TRANSPORT,
      inject: [ENV],
      useFactory: (env: Env): JevTransport => {
        const log = new Logger("TypeSafeSDK");
        return new SdkJevTransport({
          apiKey: env.TYPESAFE_API_KEY,
          ...(env.TYPESAFE_BASE_URL ? { baseURL: env.TYPESAFE_BASE_URL } : {}),
          logger: {
            debug: (m) => log.debug(m),
            info: (m) => log.log(m),
            warn: (m) => log.warn(m),
            error: (m) => log.error(m),
          },
        });
      },
    },
    {
      provide: JUDGE,
      inject: [ENV, JevLimiter, JEV_TRANSPORT],
      useFactory: (env: Env, limiter: JevLimiter, transport: JevTransport): Judge =>
        new TypesafeJudge({ transport, limiter, attemptTimeoutMs: env.JEV_ATTEMPT_TIMEOUT_MS, maxRetryWaitMs: env.JEV_MAX_RETRY_WAIT_MS }),
    },
  ],
  exports: [JevLimiter, JUDGE],
})
export class JevModule {}
