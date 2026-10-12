import { UuidSchema } from "@jev-chat/protocol";

const KEY = "jev-chat.sessionId";

/** 테스트 채팅의 현재 sessionId는 탭 수명(sessionStorage)으로만 보관한다(localStorage 금지). [P2] */
export function getSessionId(): string | null {
  const raw = sessionStorage.getItem(KEY);
  if (raw === null) return null;
  const parsed = UuidSchema.safeParse(raw); // [P4] 소문자 canonical, 형식이 틀리면 버림
  return parsed.success ? parsed.data : null;
}
export function setSessionId(sessionId: string): void {
  sessionStorage.setItem(KEY, sessionId);
}
export function clearSessionId(): void {
  sessionStorage.removeItem(KEY);
}
