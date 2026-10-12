const KEY = "jev-chat.token";

/** 접속 토큰은 탭 수명(sessionStorage)으로만 보관한다. 번들·localStorage에 두지 않는다. */
export function getToken(): string | null {
  return sessionStorage.getItem(KEY);
}
export function setToken(token: string): void {
  const t = token.trim();
  if (t) sessionStorage.setItem(KEY, t);
}
export function clearToken(): void {
  sessionStorage.removeItem(KEY);
}

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
