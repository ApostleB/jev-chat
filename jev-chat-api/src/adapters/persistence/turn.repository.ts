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
      // 행 잠금 + 원자 증가: 동시 예약에서도 turn_seq가 겹치지 않는다.
      const s = await tx.chatSession.update({
        where: { id: input.sessionId },
        data: { nextTurnSeq: { increment: 1 }, lastActiveAt: new Date() },
        select: { nextTurnSeq: true },
      });
      return tx.chatTurn.create({
        data: {
          sessionId: input.sessionId,
          turnSeq: s.nextTurnSeq - 1,
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
   * 기한을 넘기면 Prisma가 트랜잭션을 롤백하고 예외를 던진다 — 호출자는 결과를 확인한 뒤에만 이벤트를 보낸다.
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
