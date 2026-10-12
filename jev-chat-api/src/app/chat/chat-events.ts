import type { ChatDoneEvent, ChatErrorEvent, ChatStatusEvent, ChatTraceEvent } from "@jev-chat/protocol";

/** ChatService가 결과를 알리는 포트. Gateway가 room 단위로 구현한다(다른 transport로 교체 가능). */
export interface ChatEvents {
  status(e: ChatStatusEvent): void;
  done(e: ChatDoneEvent): void;
  error(e: ChatErrorEvent): void;
  /** debug 권한 소켓에만 보낸다 */
  trace(sessionId: string, e: ChatTraceEvent): void;
}
