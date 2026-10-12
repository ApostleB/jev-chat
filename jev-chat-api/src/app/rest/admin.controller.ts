import { Controller, Get, HttpCode, Inject, Logger, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { AdminConfig, KnowledgeChunkItem, KnowledgeFaqItem, Page, ReloadResponse } from "@jev-chat/protocol";
import { JEV_MODEL, TEMPLATE_VERSION } from "../../core";
import { KnowledgeRepository } from "../../adapters/persistence/knowledge.repository";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard, Roles } from "../auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "../chat/rate-limiter";
import { NoActiveKnowledgeError, SnapshotService } from "../knowledge/snapshot.service";
import { ApiException } from "./api-error";
import { ADMIN_LIMITER, IdCursor } from "./cursor";

const PageQuery = z.object({ cursor: IdCursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller("api")
@UseGuards(HttpAuthGuard)
@Roles("admin")
export class AdminController {
  private readonly log = new Logger(AdminController.name);
  private readonly reloadLimiter = new SlidingWindowRateLimiter(6, 60_000);

  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(KnowledgeRepository) private readonly knowledge: KnowledgeRepository,
    @Inject(ADMIN_LIMITER) private readonly adminLimiter: SlidingWindowRateLimiter,
  ) {}

  private activeVersion(): string {
    try {
      return this.snapshots.current().knowledgeVersionId;
    } catch (e) {
      if (e instanceof NoActiveKnowledgeError) throw new ApiException("NOT_FOUND");
      throw e;
    }
  }

  @Get("admin/config")
  async config(): Promise<AdminConfig> {
    let snap = null;
    try {
      snap = this.snapshots.current();
    } catch {
      snap = null;
    }
    const v = snap ? await this.knowledge.findVersion(snap.knowledgeVersionId) : null;
    return {
      knowledgeVersionId: snap?.knowledgeVersionId ?? null,
      packName: v?.packName ?? null,
      packVersion: v?.packVersion ?? null,
      model: JEV_MODEL,
      templateVersion: TEMPLATE_VERSION,
      policy: snap ? (JSON.parse(JSON.stringify(snap.policy)) as Record<string, unknown>) : null,
    };
  }

  @Post("admin/knowledge/reload")
  @HttpCode(201)
  async reload(@CurrentPrincipal() p: AuthedPrincipal): Promise<ReloadResponse> {
    // 관리 쓰기 공유 제한(분당 30) + 재로드 전용 제한(분당 6)
    for (const limiter of [this.adminLimiter, this.reloadLimiter]) {
      const limited = limiter.take(p.userId);
      if (!limited.ok) throw new ApiException("RATE_LIMITED", limited.retryAfterMs);
    }
    try {
      return await this.snapshots.reload();
    } catch (e) {
      if (e instanceof NoActiveKnowledgeError) throw new ApiException("NOT_FOUND");
      this.log.error(`지식 재로드 실패: ${(e as Error)?.name ?? "unknown"}`); // 이름만 기록(메시지에 DB 값이 섞일 수 있다)
      throw new ApiException("INTERNAL");
    }
  }

  @Get("knowledge/chunks")
  async chunks(@Query() query: unknown): Promise<Page<KnowledgeChunkItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.knowledge.listChunks(this.activeVersion(), { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }

  @Get("knowledge/faqs")
  async faqs(@Query() query: unknown): Promise<Page<KnowledgeFaqItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.knowledge.listFaqs(this.activeVersion(), { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }
}
