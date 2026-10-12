import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { Page, SessionSummary, TurnPage } from "@jev-chat/protocol";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { canReadSession, hasRole } from "../auth/access";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard } from "../auth/http-auth.guard";
import { toProtocolTurn } from "../chat/turn-mapper";
import { ApiException } from "./api-error";
import { TimeIdCursor } from "./cursor";

const ListQuery = z.object({
  cursor: TimeIdCursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  route: z.enum(["faq", "extractive", "reference", "clarify", "blocked", "fallback", "error"]).optional(),
  intent: z.string().max(30).optional(),
});
const TurnsQuery = z.object({ beforeTurnSeq: z.coerce.number().int().min(1).optional() });

@Controller("api/sessions")
@UseGuards(HttpAuthGuard)
export class SessionsController {
  constructor(@Inject(TurnRepository) private readonly turns: TurnRepository) {}

  @Get()
  async list(@CurrentPrincipal() p: AuthedPrincipal, @Query() query: unknown): Promise<Page<SessionSummary>> {
    const q = ListQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.turns.listSessions(
      { ...(hasRole(p, "admin") ? {} : { userId: p.userId }), ...(q.data.route ? { route: q.data.route } : {}), ...(q.data.intent ? { intent: q.data.intent } : {}) },
      { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) },
    );
  }

  @Get(":id/turns")
  async turnsOf(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string, @Query() query: unknown): Promise<TurnPage> {
    if (!z.uuid().safeParse(id).success) throw new ApiException("NOT_FOUND");
    const q = TurnsQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    const s = await this.turns.findSession(id);
    if (!s) throw new ApiException("NOT_FOUND");
    if (!canReadSession(p, s.userId)) throw new ApiException("FORBIDDEN");
    const page = await this.turns.listTurns(id, { limit: 50, ...(q.data.beforeTurnSeq ? { beforeTurnSeq: q.data.beforeTurnSeq } : {}) });
    const first = page.turns[0];
    return { turns: page.turns.map(toProtocolTurn), hasMore: page.hasMore, ...(page.hasMore && first ? { nextBeforeTurnSeq: first.turnSeq } : {}) };
  }
}
