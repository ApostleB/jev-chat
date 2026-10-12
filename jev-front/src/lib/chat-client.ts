import { io } from "socket.io-client";
import type { z } from "zod";
import {
  ChatDoneEventSchema,
  ChatErrorEventSchema,
  ChatSendAckSchema,
  ChatStatusEventSchema,
  ChatTraceEventSchema,
  ErrorCodeSchema,
  MessageTextSchema,
  PROTOCOL_VERSION,
  UuidSchema,
  SessionStartAckSchema,
  type ErrorCode,
} from "@jev-chat/protocol";
import type { TurnsAction, UiTurn } from "./turns";

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string }
  | { kind: "rejected"; code: ErrorCode };

/** [U4] 소켓 연결과 별개인 대화 세션 준비 상태 */
export type SessionState = { kind: "none" } | { kind: "syncing" } | { kind: "ready"; sessionId: string } | { kind: "error"; code: ErrorCode };

export interface HistoryMeta {
  hasMore: boolean;
  nextBeforeTurnSeq: number | null;
}

type Handler = (...a: never[]) => void;

export interface SocketLike {
  on(event: string, h: Handler): unknown;
  off(event: string, h?: Handler): unknown;
  connect(): unknown;
  disconnect(): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
}

export type IoFactory = (url: string, opts: object) => SocketLike;

export interface ChatClientOptions {
  url: string;
  token: string;
  dispatch: (a: TurnsAction) => void;
  onConn: (s: ConnState) => void;
  onSession: (s: SessionState) => void;
  onHistory?: (m: HistoryMeta, mode: "sync" | "older") => void;
  onProtocolError?: (where: string) => void;
  resumeSessionId?: string;
  /** [P2] resume 동기화가 NOT_FOUND/FORBIDDEN이라 저장된 sessionId를 버려야 할 때 */
  onResumeInvalid?: () => void;
  ioFactory?: IoFactory;
  newId?: () => string;
}

const ACK_TIMEOUT = 5000;
const UNCERTAIN = Symbol("uncertain");
const UNCERTAIN_MESSAGE = "서버 응답을 확인하지 못했습니다. '다시 보내기'를 누르면 같은 질문의 처리 여부를 확인합니다.";

export class ChatClient {
  private socket: SocketLike | null = null;
  private handlers: [string, Handler][] = [];
  private currentSession: string | null;
  private ready = false;
  /** [U3] close마다 증가 — 이전 연결의 이벤트·응답 무시 */
  private connGen = 0;
  /** [U3] 동기화(새 세션 포함)마다 증가 — 이전 session:start 응답 무시 */
  private syncGen = 0;
  private readonly newId: () => string;

  constructor(private readonly opts: ChatClientOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    // [P4] 저장값도 protocol 스키마로 파싱한 소문자 canonical만 쓴다(형식이 틀리면 새 세션)
    const resume = opts.resumeSessionId === undefined ? null : UuidSchema.safeParse(opts.resumeSessionId);
    this.currentSession = resume?.success ? resume.data : null;
  }

  get sessionId(): string | null {
    return this.ready ? this.currentSession : null;
  }

  connect(): void {
    const gen = ++this.connGen;
    const factory: IoFactory = this.opts.ioFactory ?? ((url, o) => io(url, o) as unknown as SocketLike);
    const s = factory(`${this.opts.url}/chat`, {
      auth: { token: this.opts.token, protocolVersion: PROTOCOL_VERSION },
      transports: ["websocket"],
      reconnection: true,
      autoConnect: false,
    });
    this.socket = s;
    const on = (event: string, h: (...a: any[]) => void) => {
      const guarded = ((...a: any[]) => {
        if (gen === this.connGen) h(...a);
      }) as Handler;
      s.on(event, guarded);
      this.handlers.push([event, guarded]);
    };
    on("connect", () => {
      this.opts.onConn({ kind: "connected" });
      void this.startSession(this.currentSession ?? undefined, undefined, "sync");
    });
    on("disconnect", (reason: string) => {
      this.ready = false;
      this.opts.onConn({ kind: "disconnected", reason });
      this.opts.onSession({ kind: "syncing" });
    });
    on("connect_error", (err: unknown) => {
      const message = err instanceof Error ? err.message : "";
      const code = ErrorCodeSchema.safeParse(message);
      this.opts.onConn(code.success ? { kind: "rejected", code: code.data } : { kind: "disconnected", reason: message || "connect_error" });
    });
    // [U1] 서버 이벤트는 스키마 검증을 통과한 것만 반영한다
    on("chat:status", (raw: unknown) => this.relay("chat:status", ChatStatusEventSchema, raw, (e) => ({ type: "status", e })));
    on("chat:done", (raw: unknown) => this.relay("chat:done", ChatDoneEventSchema, raw, (e) => ({ type: "done", e })));
    on("chat:error", (raw: unknown) => this.relay("chat:error", ChatErrorEventSchema, raw, (e) => ({ type: "error", e })));
    on("chat:trace", (raw: unknown) =>
      this.relay("chat:trace", ChatTraceEventSchema, raw, (e) => ({ type: "trace", e })),
    );
    this.opts.onConn({ kind: "connecting" });
    s.connect();
  }

  private relay<T>(where: string, schema: z.ZodType<T>, raw: unknown, toAction: (e: T) => TurnsAction): void {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      this.opts.onProtocolError?.(where);
      return;
    }
    this.opts.dispatch(toAction(parsed.data));
  }

  /** sync: 연결·재연결·새 세션 동기화(세션 상태를 바꿈), older: 이전 대화 페이지 */
  private async startSession(sessionId: string | undefined, beforeTurnSeq: number | undefined, mode: "sync" | "older"): Promise<boolean> {
    const s = this.socket;
    if (!s) return false;
    const conn = this.connGen;
    const sync = mode === "sync" ? ++this.syncGen : this.syncGen;
    if (mode === "sync") {
      this.ready = false;
      this.opts.onSession({ kind: "syncing" });
      // resume(재연결 포함): ack 전에 도착하는 같은 세션 이벤트를 받도록 리듀서에 대상 세션을 먼저 알린다
      if (sessionId) this.opts.dispatch({ type: "syncStart", sessionId });
    }
    const payload = { ...(sessionId ? { sessionId } : {}), ...(beforeTurnSeq ? { beforeTurnSeq } : {}) };
    const raw = await s
      .timeout(ACK_TIMEOUT)
      .emitWithAck("session:start", payload)
      .catch(() => UNCERTAIN);
    if (conn !== this.connGen || sync !== this.syncGen) return false; // [U3] 오래된 응답
    if (mode === "older" && sessionId !== this.currentSession) return false;
    const fail = (code: ErrorCode): boolean | Promise<boolean> => {
      if (mode === "sync" && sessionId && (code === "NOT_FOUND" || code === "FORBIDDEN")) {
        // [P2] 이어가려던 세션을 쓸 수 없음 → 저장값을 버리고 새 세션으로 시작
        this.opts.onResumeInvalid?.();
        this.currentSession = null;
        this.opts.dispatch({ type: "reset" });
        return this.startSession(undefined, undefined, "sync");
      }
      if (mode === "sync") this.opts.onSession({ kind: "error", code });
      return false;
    };
    if (raw === UNCERTAIN) return fail("INTERNAL");
    const parsed = SessionStartAckSchema.safeParse(raw);
    if (!parsed.success) {
      this.opts.onProtocolError?.("session:start"); // [U1]
      return fail("INTERNAL");
    }
    if (!parsed.data.ok) return fail(parsed.data.error.code);
    const d = parsed.data.data;
    this.currentSession = d.sessionId;
    this.opts.dispatch({ type: "hydrate", sessionId: d.sessionId, turns: d.turns });
    this.opts.onHistory?.({ hasMore: d.hasMore, nextBeforeTurnSeq: d.nextBeforeTurnSeq ?? null }, mode); // [U9]
    if (mode === "sync") {
      this.ready = true;
      this.opts.onSession({ kind: "ready", sessionId: d.sessionId });
    }
    return true;
  }

  /** 새 세션: 이전 세션의 늦은 응답은 세대·sessionId 검사로 버려진다 [U3] */
  newSession(): Promise<boolean> {
    this.currentSession = null;
    this.ready = false;
    this.opts.dispatch({ type: "reset" });
    return this.startSession(undefined, undefined, "sync");
  }

  loadOlder(beforeTurnSeq: number): Promise<boolean> {
    if (!this.ready || !this.currentSession) return Promise.resolve(false);
    return this.startSession(this.currentSession, beforeTurnSeq, "older");
  }

  async send(text: string, opts: { clientMsgId?: string; retryOfTurnSeq?: number } = {}): Promise<void> {
    const parsed = MessageTextSchema.safeParse(text);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "메시지 형식 오류");
    const s = this.socket;
    const sid = this.currentSession;
    if (!s || !sid || !this.ready) throw new Error("대화 세션이 준비되지 않았습니다."); // [U4]
    const conn = this.connGen;
    // [P4] 복구 재전송 ID도 소문자 canonical로 맞춘다(localSend·ack·전송 payload가 같은 값)
    const idParsed = UuidSchema.safeParse(opts.clientMsgId ?? this.newId());
    if (!idParsed.success) throw new Error("clientMsgId 형식 오류");
    const clientMsgId = idParsed.data;
    this.opts.dispatch({ type: "localSend", sessionId: sid, clientMsgId, text: parsed.data });
    const raw = await s
      .timeout(ACK_TIMEOUT)
      .emitWithAck("chat:send", { sessionId: sid, clientMsgId, text: parsed.data, ...(opts.retryOfTurnSeq ? { retryOfTurnSeq: opts.retryOfTurnSeq } : {}) })
      .catch(() => UNCERTAIN);
    if (conn !== this.connGen || sid !== this.currentSession) return; // [U3]
    const uncertain = () =>
      this.opts.dispatch({ type: "ackFailed", sessionId: sid, clientMsgId, error: { code: "INTERNAL", message: UNCERTAIN_MESSAGE, retryable: true, uncertain: true } });
    if (raw === UNCERTAIN) return uncertain(); // [U2]
    const ack = ChatSendAckSchema.safeParse(raw);
    if (!ack.success) {
      this.opts.onProtocolError?.("chat:send"); // [U1]
      return uncertain();
    }
    if (ack.data.ok) {
      this.opts.dispatch({ type: "ack", sessionId: sid, clientMsgId, turnId: ack.data.data.turnId, turnSeq: ack.data.data.turnSeq });
    } else {
      const e = ack.data.error;
      this.opts.dispatch({ type: "ackFailed", sessionId: sid, clientMsgId, error: { code: e.code, message: e.message, retryable: e.retryable, uncertain: false } });
    }
  }

  /** [U2] 미확정 실패는 같은 clientMsgId로 복구 재전송(서버 멱등), 확정 실패만 새 ID + retryOfTurnSeq */
  retry(turn: UiTurn): Promise<void> {
    if (turn.sendError?.uncertain) return this.send(turn.userText, { clientMsgId: turn.clientMsgId });
    return this.send(turn.userText, turn.turnSeq > 0 ? { retryOfTurnSeq: turn.turnSeq } : {});
  }

  close(): void {
    this.connGen++;
    this.syncGen++;
    this.ready = false;
    for (const [event, h] of this.handlers) this.socket?.off(event, h);
    this.handlers = [];
    this.socket?.disconnect();
    this.socket = null;
  }
}
