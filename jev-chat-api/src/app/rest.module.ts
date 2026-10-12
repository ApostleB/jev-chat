import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { PrismaClient } from "../generated/prisma/client";
import { ReviewRepository } from "../adapters/persistence/review.repository";
import { HttpAuthGuard } from "./auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "./chat/rate-limiter";
import { PRISMA } from "./persistence.module";
import { AllExceptionsFilter } from "./rest/all-exceptions.filter";
import { ADMIN_LIMITER } from "./rest/cursor";
import { AdminController } from "./rest/admin.controller";
import { SessionsController } from "./rest/sessions.controller";
import { TracesController } from "./rest/traces.controller";

@Module({
  controllers: [SessionsController, TracesController, AdminController],
  providers: [
    HttpAuthGuard,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: ADMIN_LIMITER, useValue: new SlidingWindowRateLimiter(30, 60_000) },
    { provide: ReviewRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new ReviewRepository(p) },
  ],
})
export class RestModule {}
