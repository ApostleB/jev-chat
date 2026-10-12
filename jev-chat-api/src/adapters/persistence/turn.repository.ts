import { randomUUID } from "node:crypto";
import type { Page, ReviewQueueItem, SessionSummary } from "@jev-chat/protocol";
import type { CompletedTurn, ContextReader, EngineResult, SourceRef, TraceRecord } from "../../core";
import type { PrismaClient } from "../../generated/prisma/client";

export interface TurnRow {
  id: string;
  sessionId: string;
  turnSeq: number;
  clientMsgId: string;
  userText: string;
  status: "processing" | "completed" | "failed";
  errorCode: string | null;
  errorRetryable: boolean | null;
  assistantText: string | null;
  route: string | null;
  sources: SourceRef[] | null;
  traceId: string | null;
  createdAt: Date;
}

type TurnWithTrace = {
  id: string;
  sessionId: string;
  turnSeq: number;
  clientMsgId: string;
  userText: string;
  status: "processing" | "completed" | "failed";
  errorCode: string | null;
  errorRetryable: boolean | null;
  assistantText: string | null;
  route: string | null;
  sources: unknown;
  createdAt: Date;
  trace: { id: string } | null;
};

function toRow(t: TurnWithTrace): TurnRow {
  return {
    id: t.id,
    sessionId: t.sessionId,
    turnSeq: t.turnSeq,
    clientMsgId: t.clientMsgId,
    userText: t.userText,
    status: t.status,
    errorCode: t.errorCode,
    errorRetryable: t.errorRetryable,
    assistantText: t.assistantText,
    route: t.route,
    sources: (t.sources as SourceRef[] | null) ?? null,
    traceId: t.trace?.id ?? null,
    createdAt: t.createdAt,
  };
}

/** DB INT(부호 있음) 컬럼의 최대값 2^31-1. message_traces.total_input_tokens의 저장 범위다. */
const DB_INT_MAX = 2_147_483_647;

function traceColumns(turnId: string, trace: TraceRecord) {
  // [D1] 방어 계약: 호출당 usage 상한(1M, sdk-transport)과 호출 수(≤13) 때문에 정상 경로에서 합계가 INT를 넘을 수 없다.
  // 그래도 범위 밖(초과·음수·비정수)이면 저장을 실패시키지 않고 컬럼은 NULL, data에는 원래 trace를 그대로 두고
  // storage.totalInputTokensOutOfRange=true로 초과 사실을 표시한다(clamp로 값을 왜곡하지 않는다).
  const total = trace.totalInputTokens;
  const inRange = Number.isSafeInteger(total) && total >= 0 && total <= DB_INT_MAX;
  const data = JSON.parse(JSON.stringify(trace)) as Record<string, unknown>;
  if (!inRange) data.storage = { totalInputTokensOutOfRange: true };
  return {
    turnId,
    knowledgeVersionId: trace.knowledgeVersionId,
    templateVersion: trace.templateVersion,
    modelVersion: trace.model,
    route: trace.route,
    intent: trace.intent,
    inScope: trace.inScope,
    ambiguity: trace.ambiguity,
    faqChoice: trace.faqChoice,
    faqProb: trace.faqProb,
    faqConfidence: trace.faqConfidence,
    bStatus: trace.bStatus,
    totalInputTokens: inRange ? total : null,
    errorCode: trace.errorCode,
    data: data as object,
  };
}

const withTrace = { trace: { select: { id: true } } } as const;

export class TurnRepository implements ContextReader {
  constructor(private readonly prisma: PrismaClient) {}

  async createSession(userId: string, channel: string): Promise<{ id: string }> {
    return this.prisma.chatSession.create({ data: { id: randomUUID(), userId, channel }, select: { id: true } });
  }

  findSession(id: string): Promise<{ id: string; userId: string } | null> {
    return this.prisma.chatSession.findUnique({ where: { id }, select: { id: true, userId: true } });
  }

  async findTurnByClientMsgId(sessionId: string, clientMsgId: string): Promise<TurnRow | null> {
    const t = await this.prisma.chatTurn.findUnique({ where: { sessionId_clientMsgId: { sessionId, clientMsgId } }, include: withTrace });
    return t ? toRow(t) : null;
  }

  async reserveTurn(input: { sessionId: string; clientMsgId: string; userText: string; retryOfTurnSeq?: number }): Promise<TurnRow> {
    const t = await this.prisma.$transaction(async (tx) => {
      // Prisma update는 사전 SELECT(잠금 없는 읽기)를 먼저 실행해, MariaDB snapshot isolation에서 동시 예약 시 1020 오류가 날 수 있다.
      // 원자 UPDATE가 먼저 행을 잠그고, 잠근 행을 current read(FOR UPDATE)로 읽는다.
      const affected = await tx.$executeRaw`UPDATE chat_sessions SET next_turn_seq = next_turn_seq + 1, last_active_at = NOW(3) WHERE id = ${input.sessionId}`;
      if (affected === 0) throw new Error(`세션을 찾을 수 없습니다: ${input.sessionId}`);
      const rows = await tx.$queryRaw<{ next_turn_seq: number | bigint }[]>`SELECT next_turn_seq FROM chat_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
      const next = Number(rows[0]?.next_turn_seq);
      return tx.chatTurn.create({
        data: {
          sessionId: input.sessionId,
          turnSeq: next - 1,
          clientMsgId: input.clientMsgId,
          userText: input.userText,
          retryOfTurnSeq: input.retryOfTurnSeq ?? null,
          status: "processing",
        },
        include: withTrace,
      });
    });
    return toRow(t);
  }

  /**
   * [P5] 저장 기한(saveMs, 기본 3000ms)을 트랜잭션 획득 대기 + 실행 시간에 나눠 적용한다.
   * 논리 tx 예산(maxWait+timeout)과 별도로, 행 잠금 대기는 DB 세션 설정(innodb_lock_wait_timeout=2초, prisma.ts)으로 2초에서 끊긴다.
   * 그 외의 장기 쿼리 상한은 계획 2B에서 다룬다. 기한 초과 트랜잭션은 커밋되지 않으므로 늦은 완료는 남지 않는다.
   */
  private txOptions(saveMs = 3000): { maxWait: number; timeout: number } {
    // saveMs는 팩 검증에서 3000 이상 보장(DB 잠금 대기 2초 + 롤백 여유). 합계(maxWait+timeout)가 saveMs를 넘지 않게 나눈다.
    const budget = Math.max(1000, saveMs);
    const maxWait = Math.min(1000, Math.floor(budget / 3));
    return { maxWait, timeout: budget - maxWait };
  }

  async completeTurn(turnId: string, result: EngineResult, opts: { saveMs?: number } = {}): Promise<{ traceId: string } | null> {
    // [P4] 장애 안내(route=error)도 completed 턴이며, 재연결 시 error 메타데이터를 복원할 수 있게 함께 저장한다.
    const isError = result.route === "error";
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.chatTurn.updateMany({
        where: { id: turnId, status: "processing" },
        data: {
          status: "completed",
          assistantText: result.text,
          route: result.route,
          sources: result.sources as unknown as object,
          errorCode: isError ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
          errorRetryable: isError ? true : null,
          completedAt: new Date(),
        },
      });
      if (updated.count === 0) return null;
      const trace = await tx.messageTrace.create({ data: traceColumns(turnId, result.trace), select: { id: true } });
      return { traceId: trace.id };
    }, this.txOptions(opts.saveMs));
  }

  async failTurn(turnId: string, code: string, retryable: boolean, trace?: TraceRecord, opts: { saveMs?: number } = {}): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.chatTurn.updateMany({
        where: { id: turnId, status: "processing" },
        data: { status: "failed", errorCode: code, errorRetryable: retryable, completedAt: new Date() },
      });
      if (updated.count === 0) return false;
      if (trace) await tx.messageTrace.create({ data: traceColumns(turnId, trace) });
      return true;
    }, this.txOptions(opts.saveMs));
  }

  async sweepProcessing(code: string): Promise<number> {
    const r = await this.prisma.chatTurn.updateMany({
      where: { status: "processing" },
      data: { status: "failed", errorCode: code, errorRetryable: true, completedAt: new Date() },
    });
    return r.count;
  }

  async loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]> {
    const rows = await this.prisma.chatTurn.findMany({
      where: { sessionId, status: "completed", turnSeq: { lt: beforeTurnSeq } },
      orderBy: { turnSeq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      turnSeq: r.turnSeq,
      userText: r.userText,
      assistantText: r.assistantText ?? "",
      sources: ((r.sources as SourceRef[] | null) ?? []).map((s) => ({ title: s.title, section: s.section })),
    }));
  }

  async listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }): Promise<{ turns: TurnRow[]; hasMore: boolean }> {
    const rows = await this.prisma.chatTurn.findMany({
      where: { sessionId, ...(opts.beforeTurnSeq ? { turnSeq: { lt: opts.beforeTurnSeq } } : {}) },
      orderBy: { turnSeq: "desc" },
      take: opts.limit + 1,
      include: withTrace,
    });
    const hasMore = rows.length > opts.limit;
    return { turns: rows.slice(0, opts.limit).reverse().map(toRow), hasMore };
  }

  async listSessions(filter: { userId?: string; route?: string; intent?: string }, page: { cursor?: string; limit: number }): Promise<Page<SessionSummary>> {
    const [cursorAt, cursorId] = page.cursor ? page.cursor.split("|") : [undefined, undefined];
    const rows = await this.prisma.chatSession.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.route || filter.intent
          ? { turns: { some: { ...(filter.route ? { route: filter.route } : {}), ...(filter.intent ? { trace: { intent: filter.intent } } : {}) } } }
          : {}),
        ...(cursorAt && cursorId
          ? { OR: [{ lastActiveAt: { lt: new Date(cursorAt) } }, { lastActiveAt: new Date(cursorAt), id: { lt: cursorId } }] }
          : {}),
      },
      orderBy: [{ lastActiveAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      include: { _count: { select: { turns: true } } },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((s) => ({
        id: s.id, userId: s.userId, channel: s.channel, createdAt: s.createdAt.toISOString(), lastActiveAt: s.lastActiveAt.toISOString(), turnCount: s._count.turns,
      })),
      nextCursor: rows.length > page.limit && last ? `${last.lastActiveAt.toISOString()}|${last.id}` : null,
    };
  }

  async findTrace(traceId: string) {
    const t = await this.prisma.messageTrace.findUnique({ where: { id: traceId }, include: { turn: { select: { sessionId: true, session: { select: { userId: true } } } } } });
    if (!t) return null;
    return { id: t.id, turnId: t.turnId, sessionId: t.turn.sessionId, sessionUserId: t.turn.session.userId, route: t.route, createdAt: t.createdAt, data: t.data as Record<string, unknown> };
  }

  async reviewQueue(page: { cursor?: string; limit: number }): Promise<Page<ReviewQueueItem>> {
    const [cursorAt, cursorId] = page.cursor ? page.cursor.split("|") : [undefined, undefined];
    const rows = await this.prisma.messageTrace.findMany({
      where: {
        OR: [{ route: { in: ["reference", "clarify", "fallback", "error"] } }, { faqProb: { lt: 0.9 } }],
        ...(cursorAt && cursorId ? { AND: [{ OR: [{ createdAt: { lt: new Date(cursorAt) } }, { createdAt: new Date(cursorAt), id: { lt: cursorId } }] }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      include: { turn: { select: { sessionId: true, userText: true, assistantText: true } }, _count: { select: { reviews: true } } },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((t) => ({
        traceId: t.id, turnId: t.turnId, sessionId: t.turn.sessionId, userText: t.turn.userText, assistantText: t.turn.assistantText,
        route: t.route as ReviewQueueItem["route"], intent: t.intent, faqProb: t.faqProb, reviewed: t._count.reviews > 0, createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }
}
