import { randomUUID } from "node:crypto";
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

function traceColumns(turnId: string, trace: TraceRecord) {
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
    totalInputTokens: trace.totalInputTokens,
    errorCode: trace.errorCode,
    data: JSON.parse(JSON.stringify(trace)) as object,
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
   * 주의: Prisma 트랜잭션 timeout은 진행 중인 쿼리를 취소하지 않는다. 행 잠금 대기 중이면 그 쿼리가 끝날 때
   * (최대 innodb_lock_wait_timeout)까지 promise가 reject되지 않는다. 다만 기한 초과 트랜잭션은 커밋되지 않으므로 늦은 완료는 남지 않는다.
   * 실제 시간 상한은 계획 2B에서 결정(DB 확인 후).
   */
  private txOptions(saveMs = 3000): { maxWait: number; timeout: number } {
    // saveMs는 팩 검증에서 1000 이상이 보장된다. 합계(maxWait+timeout)가 saveMs를 넘지 않게 나눈다.
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
}
