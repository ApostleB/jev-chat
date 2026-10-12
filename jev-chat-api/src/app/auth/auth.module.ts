import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env.schema";
import { AUTH_PROVIDER } from "./auth.types";
import { DevAuthProvider } from "./dev-auth.provider";

@Global()
@Module({
  providers: [{ provide: AUTH_PROVIDER, inject: [ENV], useFactory: (env: Env) => new DevAuthProvider(env.DEV_ACCESS_TOKEN ?? "") }],
  exports: [AUTH_PROVIDER],
})
export class AuthModule {}
