import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ReviewRequestSchema, type Page, type Review, type ReviewQueueItem, type TraceDetail } from "@jev-chat/protocol";
import { ReviewRepository } from "../../adapters/persistence/review.repository";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { canReadSession } from "../auth/access";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard, Roles } from "../auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "../chat/rate-limiter";
import { parseRoute } from "../chat/turn-mapper";
import { ApiException } from "./api-error";
import { ADMIN_LIMITER, TimeIdCursor } from "./cursor";

const PageQuery = z.object({ cursor: TimeIdCursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@Controller("api")
@UseGuards(HttpAuthGuard)
export class TracesController {
  constructor(
    @Inject(TurnRepository) private readonly turns: TurnRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(ADMIN_LIMITER) private readonly adminLimiter: SlidingWindowRateLimiter,
  ) {}

  @Get("traces/:id")
  @Roles("debug")
  async trace(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string): Promise<TraceDetail> {
    const t = z.uuid().safeParse(id).success ? await this.turns.findTrace(id) : null;
    if (!t) throw new ApiException("NOT_FOUND");
    if (!canReadSession(p, t.sessionUserId)) throw new ApiException("FORBIDDEN");
    return { id: t.id, turnId: t.turnId, sessionId: t.sessionId, route: parseRoute(t.route), createdAt: t.createdAt.toISOString(), data: t.data, reviews: await this.reviews.listByTrace(t.id) };
  }

  @Get("reviews/queue")
  @Roles("admin")
  async queue(@Query() query: unknown): Promise<Page<ReviewQueueItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.turns.reviewQueue({ limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }

  @Post("traces/:id/review")
  @HttpCode(201)
  @Roles("admin")
  async review(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string, @Body() body: unknown): Promise<Review> {
    const limited = this.adminLimiter.take(p.userId);
    if (!limited.ok) throw new ApiException("RATE_LIMITED", limited.retryAfterMs);
    const parsed = ReviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiException("INVALID_INPUT");
    const t = z.uuid().safeParse(id).success ? await this.turns.findTrace(id) : null;
    if (!t) throw new ApiException("NOT_FOUND");
    return this.reviews.create(t.id, p.userId, parsed.data);
  }
}
