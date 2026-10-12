import { Inject, Logger } from "@nestjs/common";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayInit } from "@nestjs/websockets";
import {
  ChatSendRequestSchema,
  isWithinPayloadLimit,
  SessionStartRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Ack,
  type ChatSendResponse,
  type ChatTraceEvent,
  type ErrorCode,
  type SessionStartResponse,
} from "@jev-chat/protocol";
import type { Namespace, Socket } from "socket.io";
import type { AuthedPrincipal, AuthProvider } from "../auth/auth.types";
import { AUTH_PROVIDER } from "../auth/auth.types";
import { hasRole } from "../auth/access";
import { ChatService, type ReplyPort } from "./chat.service";
import type { ChatEvents } from "./chat-events";
import { ERROR_MESSAGES } from "./turn-mapper";

const room = (sessionId: string) => `session:${sessionId}`;
const CHANNEL = "front-test";

type SocketData = { principal: AuthedPrincipal };

function failAck<T>(code: ErrorCode): Ack<T> {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable: code === "INTERNAL" } };
}

function connectError(code: ErrorCode, data: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { data: { code, ...data } });
}

@WebSocketGateway({ namespace: "/chat" })
export class ChatGateway implements OnGatewayInit {
  private readonly log = new Logger(ChatGateway.name);
  @WebSocketServer() private server!: Namespace;

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
  ) {}

  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      void (async () => {
        const { token, protocolVersion } = (socket.handshake.auth ?? {}) as { token?: unknown; protocolVersion?: unknown };
        if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(protocolVersion)) {
          return next(connectError("PROTOCOL_UNSUPPORTED", { supported: SUPPORTED_PROTOCOL_VERSIONS }));
        }
        const principal = typeof token === "string" ? await this.auth.verify(token) : null;
        if (!principal) return next(connectError("UNAUTHORIZED"));
        (socket.data as SocketData).principal = principal;
        if (principal.expiresAt) {
          const ms = principal.expiresAt - Date.now();
          if (ms <= 0) return next(connectError("UNAUTHORIZED"));
          const timer = setTimeout(() => socket.disconnect(true), ms);
          timer.unref();
          socket.once("disconnect", () => clearTimeout(timer));
        }
        next();
      })().catch((e: unknown) => {
        this.log.error(`인증 처리 오류: ${(e as Error)?.name ?? "unknown"}`);
        next(connectError("INTERNAL"));
      });
    });
  }

  private principal(socket: Socket): AuthedPrincipal {
    return (socket.data as SocketData).principal;
  }

  /** room 기반 이벤트. [B8] trace는 room 안에서 debug 권한이 있는 소켓에만 개별 발송한다(수신자 기준). */
  private roomEvents(): ChatEvents {
    return {
      status: (e) => this.server.to(room(e.sessionId)).emit("chat:status", e),
      done: (e) => this.server.to(room(e.sessionId)).emit("chat:done", e),
      error: (e) => this.server.to(room(e.sessionId)).emit("chat:error", e),
      trace: (sessionId: string, e: ChatTraceEvent) => {
        this.server
          .in(room(sessionId))
          .fetchSockets()
          .then((sockets) => {
            for (const s of sockets) {
              const p = (s.data as SocketData | undefined)?.principal;
              if (p && hasRole(p, "debug")) s.emit("chat:trace", e);
            }
          })
          .catch((err: unknown) => this.log.warn(`trace 발송 실패: ${(err as Error)?.name ?? "unknown"}`));
      },
    };
  }

  /** [B7] 요청한 소켓 하나에만 보내는 재발송 포트 */
  private replyTo(socket: Socket): ReplyPort {
    return {
      done: (e) => socket.emit("chat:done", e),
      error: (e) => socket.emit("chat:error", e),
    };
  }

  @SubscribeMessage("session:start")
  async onSessionStart(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<SessionStartResponse>> {
    try {
      if (!isWithinPayloadLimit(body)) return failAck("INVALID_INPUT");
      const parsed = SessionStartRequestSchema.safeParse(body ?? {});
      if (!parsed.success) return failAck("INVALID_INPUT");
      // [B3] 서비스가 권한 확인(또는 생성) 뒤 join을 호출하고, 그다음 이력을 조회한다
      return await this.chat.startSession(this.principal(socket), parsed.data, CHANNEL, async (sid) => {
        await socket.join(room(sid));
      });
    } catch (e) {
      this.log.error(`session:start 오류: ${(e as Error)?.name ?? "unknown"}`);
      return failAck("INTERNAL"); // [B1]
    }
  }

  @SubscribeMessage("chat:send")
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<ChatSendResponse>> {
    try {
      if (!isWithinPayloadLimit(body)) return failAck("INVALID_INPUT");
      const parsed = ChatSendRequestSchema.safeParse(body);
      if (!parsed.success) return failAck("INVALID_INPUT");
      const p = this.principal(socket);
      // 권한을 먼저 확인한 뒤 room에 참여한다 → 다른 사용자의 세션 이벤트를 받을 수 없다.
      // (처리 결과 이벤트가 ack보다 먼저 올 수 있으므로 send 호출 전에 참여한다)
      const denied = await this.chat.authorize(p, parsed.data.sessionId, "write");
      if (denied) return denied;
      await socket.join(room(parsed.data.sessionId));
      return await this.chat.send(p, parsed.data, this.roomEvents(), this.replyTo(socket));
    } catch (e) {
      this.log.error(`chat:send 오류: ${(e as Error)?.name ?? "unknown"}`);
      return failAck("INTERNAL"); // [B1]
    }
  }
}
