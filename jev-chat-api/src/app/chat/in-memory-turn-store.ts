import { randomUUID } from "node:crypto";
import type { CompletedTurn, EngineResult, TraceRecord } from "../../core";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import type { TurnStore } from "./turn-store";

/** 대소문자 무시 비교 키. 실제 DB(utf8mb4_unicode_ci)가 UUID를 이렇게 비교하므로 표기 차이를 숨기지 않게 같은 규칙을 쓴다. */
const ci = (v: string) => v.toLowerCase();

/** 단위 테스트 전용 TurnStore. 실제 동작은 TurnRepository 통합 테스트로 검증한다. */
export class InMemoryTurnStore implements TurnStore {
  readonly sessions = new Map<string, { id: string; userId: string; next: number }>();
  readonly turns: TurnRow[] = [];
  readonly traces = new Map<string, TraceRecord>();
  failComplete = false;
  /** [B1] 지정한 메서드가 예외를 던지게 한다 */
  throwOn = new Set<string>();
  /** [B2] failTurn 직전에 실행(경합 재현용) */
  beforeFail: (() => void) | null = null;
  /** failTurn이 상태와 무관하게 false를 반환(다른 경로가 종료했으나 아직 processing으로 보이는 경합 재현) */
  failReturnsFalse = false;
  readonly calls: string[] = [];

  async createSession(userId: string, _channel: string) {
    const id = randomUUID();
    this.sessions.set(ci(id), { id, userId, next: 1 });
    return { id };
  }
  async findSession(id: string) {
    this.calls.push("findSession");
    if (this.throwOn.has("findSession")) throw new Error("db down");
    const s = this.sessions.get(ci(id));
    return s ? { id: s.id, userId: s.userId } : null;
  }
  async findTurnByClientMsgId(sessionId: string, clientMsgId: string) {
    return this.turns.find((t) => ci(t.sessionId) === ci(sessionId) && ci(t.clientMsgId) === ci(clientMsgId)) ?? null;
  }
  async reserveTurn(input: { sessionId: string; clientMsgId: string; userText: string; retryOfTurnSeq?: number }) {
    const s = this.sessions.get(ci(input.sessionId))!; // FK는 대소문자 무시로 해석되지만 컬럼에는 넘긴 문자열이 그대로 저장된다
    const row: TurnRow = {
      id: randomUUID(), sessionId: input.sessionId, turnSeq: s.next++, clientMsgId: input.clientMsgId, userText: input.userText,
      status: "processing", errorCode: null, errorRetryable: null, assistantText: null, route: null, sources: null, traceId: null, createdAt: new Date(),
    };
    this.turns.push(row);
    return row;
  }
  async completeTurn(turnId: string, result: EngineResult) {
    if (this.failComplete) throw new Error("db down");
    const t = this.turns.find((x) => x.id === turnId);
    if (!t || t.status !== "processing") return null;
    const traceId = randomUUID();
    Object.assign(t, {
      status: "completed", assistantText: result.text, route: result.route, sources: result.sources, traceId,
      errorCode: result.route === "error" ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
      errorRetryable: result.route === "error" ? true : null,
    });
    this.traces.set(traceId, result.trace);
    return { traceId };
  }
  async failTurn(turnId: string, code: string, retryable: boolean) {
    this.beforeFail?.();
    if (this.failReturnsFalse) return false;
    const t = this.turns.find((x) => x.id === turnId);
    if (!t || t.status !== "processing") return false;
    Object.assign(t, { status: "failed", errorCode: code, errorRetryable: retryable });
    return true;
  }
  async listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }) {
    this.calls.push("listTurns");
    const all = this.turns.filter((t) => ci(t.sessionId) === ci(sessionId) && (!opts.beforeTurnSeq || t.turnSeq < opts.beforeTurnSeq)).sort((a, b) => a.turnSeq - b.turnSeq);
    return { turns: all.slice(-opts.limit), hasMore: all.length > opts.limit };
  }
  async loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]> {
    return this.turns
      .filter((t) => ci(t.sessionId) === ci(sessionId) && t.status === "completed" && t.turnSeq < beforeTurnSeq)
      .sort((a, b) => a.turnSeq - b.turnSeq)
      .slice(-limit)
      .map((t) => ({ turnSeq: t.turnSeq, userText: t.userText, assistantText: t.assistantText ?? "", sources: (t.sources ?? []).map((s) => ({ title: s.title, section: s.section })) }));
  }
}
