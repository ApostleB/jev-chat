import type {
  Ack,
  ChatSendRequest,
  ChatSendResponse,
  ErrorCode,
  SessionStartRequest,
  SessionStartResponse,
} from "@jev-chat/protocol";
import { ChatEngine, DEFAULT_POLICY, ExtractiveAnswerer, type EngineResult, type ExecutionSnapshot, type Judge } from "../../core";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import type { AuthedPrincipal } from "../auth/auth.types";
import { canReadSession, canWriteSession } from "../auth/access";
import type { SnapshotService } from "../knowledge/snapshot.service";
import type { ChatEvents } from "./chat-events";
import type { SlidingWindowRateLimiter } from "./rate-limiter";
import type { SessionQueue } from "./session-queue";
import { ERROR_MESSAGES, toDoneEvent, toErrorEvent, toProtocolTurn } from "./turn-mapper";
import type { TurnStore } from "./turn-store";

const HISTORY_LIMIT = 50;
const QUEUE_FULL_RETRY_MS = 2000;

/** [B7] 요청한 소켓 하나에만 보내는 포트 */
export type ReplyPort = Pick<ChatEvents, "done" | "error">;

interface Deps {
  store: TurnStore;
  snapshots: Pick<SnapshotService, "current">;
  judge: Judge;
  queue: SessionQueue;
  sendLimiter: SlidingWindowRateLimiter;
  sessionLimiter: SlidingWindowRateLimiter;
  replayLimiter: SlidingWindowRateLimiter;
  /** 예외 이름만 기록한다(값·SQL·스택 금지) */
  log?: (where: string, err: unknown) => void;
}

/** [B4] 큐에 들어간 턴의 상태. 만료와 실행 중 하나만 일어난다. */
interface QueuedTurn {
  started: boolean;
  expired: boolean;
  timer: NodeJS.Timeout | null;
}

function fail<T>(code: ErrorCode, retryAfterMs?: number): Ack<T> {
  const retryable = code === "RATE_LIMITED" || code === "QUEUE_FULL" || code === "INTERNAL";
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
}

export class ChatService {
  private readonly inflight = new Set<string>();
  private readonly engine: ChatEngine;
  private readonly log: (where: string, err: unknown) => void;

  constructor(private readonly deps: Deps) {
    this.engine = new ChatEngine({ judge: deps.judge, answerer: new ExtractiveAnswerer(), contextReader: deps.store });
    this.log = deps.log ?? (() => {});
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  /** 세션 접근 권한(read: 본인·admin, write: 본인만). 허용이면 null. [B1] 조회 실패는 INTERNAL */
  async authorize(p: AuthedPrincipal, sessionId: string, mode: "read" | "write"): Promise<Ack<never> | null> {
    try {
      const s = await this.deps.store.findSession(sessionId);
      if (!s) return fail("NOT_FOUND");
      if (!(mode === "write" ? canWriteSession : canReadSession)(p, s.userId)) return fail("FORBIDDEN");
      return null;
    } catch (e) {
      this.log("authorize", e);
      return fail("INTERNAL");
    }
  }

  /** [B3] 권한 확인(또는 생성) → join → 이력 조회. 조회 이후의 완료 이벤트는 이미 room에서 받는다. */
  async startSession(
    p: AuthedPrincipal,
    req: SessionStartRequest,
    channel: string,
    join: (sessionId: string) => Promise<void>,
  ): Promise<Ack<SessionStartResponse>> {
    try {
      let sessionId = req.sessionId;
      if (!sessionId) {
        const limited = this.deps.sessionLimiter.take(p.userId);
        if (!limited.ok) return fail("RATE_LIMITED", limited.retryAfterMs);
        sessionId = (await this.deps.store.createSession(p.userId, channel)).id;
      } else {
        const denied = await this.authorize(p, sessionId, "read");
        if (denied) return denied;
      }
      await join(sessionId);
      const page = await this.deps.store.listTurns(sessionId, { limit: HISTORY_LIMIT, ...(req.beforeTurnSeq ? { beforeTurnSeq: req.beforeTurnSeq } : {}) });
      const first = page.turns[0];
      return {
        ok: true,
        data: {
          sessionId,
          turns: page.turns.map(toProtocolTurn),
          hasMore: page.hasMore,
          ...(page.hasMore && first ? { nextBeforeTurnSeq: first.turnSeq } : {}),
        },
      };
    } catch (e) {
      this.log("startSession", e);
      return fail("INTERNAL");
    }
  }

  async send(p: AuthedPrincipal, req: ChatSendRequest, events: ChatEvents, reply: ReplyPort): Promise<Ack<ChatSendResponse>> {
    const denied = await this.authorize(p, req.sessionId, "write");
    if (denied) return denied;
    try {
      return await this.deps.queue.withLock(req.sessionId, async () => {
        // ① 멱등 조회 (큐가 가득 차도 동작)
        const existing = await this.deps.store.findTurnByClientMsgId(req.sessionId, req.clientMsgId);
        if (existing) {
          if (existing.userText !== req.text) return fail<ChatSendResponse>("INVALID_INPUT");
          const limited = this.deps.replayLimiter.take(p.userId);
          if (!limited.ok) return fail<ChatSendResponse>("RATE_LIMITED", limited.retryAfterMs);
          await this.replay(existing, reply);
          return { ok: true, data: { turnId: existing.id, turnSeq: existing.turnSeq, status: "duplicate" } };
        }
        // ② 새 요청 레이트 리밋
        const limited = this.deps.sendLimiter.take(p.userId);
        if (!limited.ok) return fail<ChatSendResponse>("RATE_LIMITED", limited.retryAfterMs);
        // ③ 슬롯 예약
        if (!this.deps.queue.tryReserve(req.sessionId)) return fail<ChatSendResponse>("QUEUE_FULL", QUEUE_FULL_RETRY_MS);
        // ④ DB 원자 예약
        let turn: TurnRow;
        try {
          turn = await this.deps.store.reserveTurn({
            sessionId: req.sessionId,
            clientMsgId: req.clientMsgId,
            userText: req.text,
            ...(req.retryOfTurnSeq ? { retryOfTurnSeq: req.retryOfTurnSeq } : {}),
          });
        } catch (e) {
          this.deps.queue.release(req.sessionId);
          this.log("reserveTurn", e);
          return fail<ChatSendResponse>("INTERNAL");
        }
        // ⑤ 만료 타이머 + enqueue [B4]
        this.inflight.add(turn.id);
        const state: QueuedTurn = { started: false, expired: false, timer: null };
        state.timer = setTimeout(() => void this.expire(turn, state, events), this.queueMs());
        state.timer.unref?.();
        events.status({ sessionId: req.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq, stage: "queued" });
        // 같은 프로세스 안에서 ack가 처리 이벤트보다 먼저 나가도록 다음 매크로태스크에서 등록(네트워크 재정렬 대비 클라이언트 upsert[B3]는 유지)
        this.defer("enqueue", () => this.deps.queue.run(req.sessionId, () => this.process(p, turn, state, events)));
        return { ok: true, data: { turnId: turn.id, turnSeq: turn.turnSeq, status: "accepted" } };
      });
    } catch (e) {
      this.log("send", e);
      return fail("INTERNAL");
    }
  }

  /** setImmediate로 넘기는 콜백의 예외가 uncaughtException이 되지 않게 감싼다 */
  private defer(where: string, fn: () => void): void {
    setImmediate(() => {
      try {
        fn();
      } catch (e) {
        this.log(where, e);
      }
    });
  }

  private queueMs(): number {
    try {
      return this.deps.snapshots.current().policy.deadlines.queueMs;
    } catch {
      return DEFAULT_POLICY.deadlines.queueMs;
    }
  }

  /** 슬롯·진행 목록을 정확히 한 번 반환 */
  private finish(turn: TurnRow, state: QueuedTurn): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!this.inflight.delete(turn.id)) return;
    this.deps.queue.release(turn.sessionId);
  }

  /** [B4] 실행 전에 대기 상한이 지나면 실패로 확정한다 */
  private async expire(turn: TurnRow, state: QueuedTurn, events: ChatEvents): Promise<void> {
    if (state.started || state.expired) return;
    state.expired = true;
    try {
      const changed = await this.deps.store.failTurn(turn.id, "QUEUE_TIMEOUT", true);
      if (changed) events.error(toErrorEvent({ ...turn, status: "failed", errorCode: "QUEUE_TIMEOUT", errorRetryable: true }, turn.sessionId));
      else await this.notifyStored(turn, events);
    } catch (e) {
      this.log("expire", e);
    } finally {
      this.finish(turn, state);
    }
  }

  /** [M-1] failTurn이 false면 다른 경로가 이미 종료시킨 것이다. 저장된 최신 상태대로 room에 알린다(processing이면 알리지 않는다). */
  private async notifyStored(turn: TurnRow, events: ChatEvents): Promise<void> {
    try {
      const latest = await this.deps.store.findTurnByClientMsgId(turn.sessionId, turn.clientMsgId);
      if (latest?.status === "completed") events.done(toDoneEvent(latest, latest.sessionId));
      else if (latest?.status === "failed") events.error(toErrorEvent(latest, latest.sessionId));
    } catch (e) {
      this.log("notifyStored", e);
    }
  }

  /** [B2][B7] 이미 있는 턴의 결과를 요청 소켓에 다시 보낸다 */
  private async replay(row: TurnRow, reply: ReplyPort): Promise<void> {
    let current: TurnRow = row;
    if (current.status === "processing") {
      if (this.inflight.has(current.id)) return; // 처리 중이면 room 이벤트로 받게 된다
      const changed = await this.deps.store.failTurn(current.id, "RESTARTED", true);
      current = changed
        ? { ...current, status: "failed", errorCode: "RESTARTED", errorRetryable: true }
        : ((await this.deps.store.findTurnByClientMsgId(current.sessionId, current.clientMsgId)) ?? current);
    }
    const final = current;
    // duplicate ack가 먼저 나가도록 다음 macrotask에서 보낸다(queue.run과 같은 규칙). 예외는 프로세스를 죽이지 않는다.
    if (final.status === "completed") this.defer("replay", () => reply.done(toDoneEvent(final, final.sessionId)));
    else if (final.status === "failed") this.defer("replay", () => reply.error(toErrorEvent(final, final.sessionId)));
  }

  private async process(p: AuthedPrincipal, turn: TurnRow, state: QueuedTurn, events: ChatEvents): Promise<void> {
    if (state.expired) return; // 만료된 작업은 실행하지 않는다(정리는 expire가 함)
    state.started = true;
    if (state.timer) clearTimeout(state.timer);
    const ref = { sessionId: turn.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq };
    const failWith = async (code: ErrorCode, retryable: boolean) => {
      const changed = await this.deps.store.failTurn(turn.id, code, retryable).catch((e) => (this.log("failTurn", e), false));
      if (changed) events.error(toErrorEvent({ ...turn, status: "failed", errorCode: code, errorRetryable: retryable }, turn.sessionId));
      else await this.notifyStored(turn, events);
    };
    try {
      let snapshot: ExecutionSnapshot;
      try {
        snapshot = this.deps.snapshots.current();
      } catch (e) {
        this.log("snapshot", e);
        await failWith("INTERNAL", false);
        return;
      }
      const { engineMs, saveMs } = snapshot.policy.deadlines;
      let result: EngineResult;
      try {
        result = await this.engine.handle(
          { principal: p, sessionId: turn.sessionId, turnId: turn.id, turnSeq: turn.turnSeq, text: turn.userText, snapshot, signal: AbortSignal.timeout(engineMs) },
          (prog) => events.status({ ...ref, stage: prog.stage }),
        );
      } catch (e) {
        this.log("engine", e);
        await failWith("INTERNAL", false);
        return;
      }
      let saved: { traceId: string } | null;
      try {
        saved = await this.deps.store.completeTurn(turn.id, result, { saveMs });
      } catch (e) {
        this.log("completeTurn", e);
        await failWith("INTERNAL", false);
        return;
      }
      if (!saved) return; // 이미 다른 경로에서 종료됨
      const row: TurnRow = {
        ...turn,
        status: "completed",
        assistantText: result.text,
        route: result.route,
        sources: result.sources,
        traceId: saved.traceId,
        errorCode: result.route === "error" ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
        errorRetryable: result.route === "error" ? true : null,
      };
      events.done(toDoneEvent(row, turn.sessionId));
      // [B8] trace는 항상 포트로 보낸다. 받는 소켓의 debug 권한은 Gateway가 거른다.
      events.trace(turn.sessionId, { sessionId: turn.sessionId, traceId: saved.traceId, trace: JSON.parse(JSON.stringify(result.trace)) });
    } finally {
      this.finish(turn, state);
    }
  }
}
