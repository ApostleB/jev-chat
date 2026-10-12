import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChatClient, type ConnState, type HistoryMeta, type IoFactory, type SessionState } from "@/lib/chat-client";
import { API_URL } from "@/lib/token-store";
import { initialTurns, orderedTurns, turnsReducer, type UiTurn } from "@/lib/turns";

/**
 * 채팅 세션 수명은 App 수준이다(화면 전환에도 유지) [U9].
 * authEpoch가 바뀌면(로그인·로그아웃·토큰 교체) 상태를 비우고 새 세션으로 시작한다 [U6].
 * reconnect()는 같은 인증 세대 안에서 마지막 세션으로 재개한다 [U4].
 */
export function useChat(token: string | null, authEpoch: number, opts: { ioFactory?: IoFactory } = {}) {
  const [state, dispatch] = useReducer(turnsReducer, initialTurns);
  const [conn, setConn] = useState<ConnState>({ kind: "idle" });
  const [session, setSession] = useState<SessionState>({ kind: "none" });
  const [history, setHistory] = useState<HistoryMeta>({ hasMore: false, nextBeforeTurnSeq: null });
  const [protocolErrors, setProtocolErrors] = useState(0);
  const [nonce, setNonce] = useState(0);
  const clientRef = useRef<ChatClient | null>(null);
  const lastSession = useRef<{ epoch: number; sessionId: string } | null>(null);
  const { ioFactory } = opts;

  useEffect(() => {
    const resume = lastSession.current?.epoch === authEpoch ? lastSession.current.sessionId : undefined;
    if (!resume) {
      dispatch({ type: "reset" });
      setHistory({ hasMore: false, nextBeforeTurnSeq: null });
    }
    setSession({ kind: "none" });
    if (!token) {
      setConn({ kind: "idle" });
      return;
    }
    const c = new ChatClient({
      url: API_URL,
      token,
      dispatch,
      onConn: setConn,
      onSession: (s) => {
        setSession(s);
        if (s.kind === "ready") lastSession.current = { epoch: authEpoch, sessionId: s.sessionId };
      },
      onHistory: (m) => setHistory(m),
      onProtocolError: () => setProtocolErrors((n) => n + 1),
      ...(resume ? { resumeSessionId: resume } : {}),
      ...(ioFactory ? { ioFactory } : {}),
    });
    clientRef.current = c;
    c.connect();
    return () => {
      c.close();
      if (clientRef.current === c) clientRef.current = null;
    };
  }, [token, authEpoch, nonce, ioFactory]);

  const send = useCallback((text: string) => clientRef.current?.send(text) ?? Promise.reject(new Error("연결되지 않았습니다.")), []);
  const retry = useCallback((t: UiTurn) => clientRef.current?.retry(t) ?? Promise.reject(new Error("연결되지 않았습니다.")), []);
  const newSession = useCallback(async () => {
    lastSession.current = null;
    await clientRef.current?.newSession();
  }, []);
  const loadOlder = useCallback(async () => {
    if (history.nextBeforeTurnSeq !== null) await clientRef.current?.loadOlder(history.nextBeforeTurnSeq);
  }, [history.nextBeforeTurnSeq]);
  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  const turns = useMemo(() => orderedTurns(state), [state]);
  return { state, turns, conn, session, history, protocolErrors, send, retry, newSession, loadOlder, reconnect };
}

export type ChatHandle = ReturnType<typeof useChat>;
