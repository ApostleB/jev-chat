import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeSocket } from "../test/fakes";
import { useChat } from "./use-chat";

const sid = "00000000-0000-4000-8000-000000000001";

function factory() {
  const sockets: FakeSocket[] = [];
  const ioFactory = () => {
    const s = new FakeSocket();
    s.ackResponder = () => ({ ok: true, data: { sessionId: sid, turns: [], hasMore: true, nextBeforeTurnSeq: 3 } });
    sockets.push(s);
    return s as never;
  };
  return { sockets, ioFactory };
}

const KEY = "jev-chat.sessionId";
const sid2 = "00000000-0000-4000-8000-000000000002";

describe("useChat", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("동기화 후 ready + history 반영", async () => {
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session).toEqual({ kind: "ready", sessionId: sid }));
    expect(result.current.history).toEqual({ hasMore: true, nextBeforeTurnSeq: 3 });
  });

  it("거절 후 reconnect는 새 클라이언트를 만들고 같은 세션으로 재개", async () => {
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    act(() => f.sockets[0]!.serverEmit("connect_error", new Error("UNAUTHORIZED")));
    expect(result.current.conn).toEqual({ kind: "rejected", code: "UNAUTHORIZED" });
    act(() => result.current.reconnect());
    expect(f.sockets).toHaveLength(2);
    act(() => f.sockets[1]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    expect(f.sockets[1]!.emitted[0]).toEqual({ event: "session:start", payload: { sessionId: sid } });
  });

  it("인증 세대(authEpoch)가 바뀌면 상태를 비우고 새 세션으로 시작", async () => {
    const f = factory();
    const { result, rerender } = renderHook(({ epoch }) => useChat("tok", epoch, { ioFactory: f.ioFactory }), { initialProps: { epoch: 0 } });
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    rerender({ epoch: 1 });
    expect(result.current.session).toEqual({ kind: "none" });
    act(() => f.sockets[1]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    expect(f.sockets[1]!.emitted[0]).toEqual({ event: "session:start", payload: {} });
  });

  it("토큰이 없으면 연결하지 않는다", () => {
    const f = factory();
    const { result } = renderHook(() => useChat(null, 0, { ioFactory: f.ioFactory }));
    expect(f.sockets).toHaveLength(0);
    expect(result.current.conn).toEqual({ kind: "idle" });
  });

  it("[P2] ready가 되면 sessionId를 sessionStorage에만 저장", async () => {
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    expect(sessionStorage.getItem(KEY)).toBe(sid);
    expect(localStorage.length).toBe(0);
  });

  it("[P2] 다음 로드(마운트)는 저장된 sessionId로 resume", async () => {
    sessionStorage.setItem(KEY, sid);
    const f = factory();
    renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(f.sockets[0]!.emitted).toHaveLength(1));
    expect(f.sockets[0]!.emitted[0]).toEqual({ event: "session:start", payload: { sessionId: sid } });
  });

  it("[P2] resume가 NOT_FOUND이면 저장값을 지우고 새 세션으로 시작해 새 값을 저장", async () => {
    sessionStorage.setItem(KEY, sid);
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    const s = f.sockets[0]!;
    let call = 0;
    s.ackResponder = () =>
      ++call === 1
        ? { ok: false, error: { code: "NOT_FOUND", message: "x", retryable: false } }
        : { ok: true, data: { sessionId: sid2, turns: [], hasMore: false } };
    act(() => s.serverEmit("connect"));
    await waitFor(() => expect(result.current.session).toEqual({ kind: "ready", sessionId: sid2 }));
    expect(s.emitted.map((e) => e.payload)).toEqual([{ sessionId: sid }, {}]);
    expect(sessionStorage.getItem(KEY)).toBe(sid2);
  });

  it("[P2] resume가 FORBIDDEN이고 새 세션도 실패하면 잘못된 저장값은 남지 않는다", async () => {
    sessionStorage.setItem(KEY, sid);
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    const s = f.sockets[0]!;
    s.ackResponder = (_e, p) =>
      (p as { sessionId?: string }).sessionId
        ? { ok: false, error: { code: "FORBIDDEN", message: "x", retryable: false } }
        : { ok: false, error: { code: "INTERNAL", message: "x", retryable: true } };
    act(() => s.serverEmit("connect"));
    await waitFor(() => expect(result.current.session).toEqual({ kind: "error", code: "INTERNAL" }));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("[P2] 새 대화는 저장값을 새 sessionId로 교체", async () => {
    const f = factory();
    const { result } = renderHook(() => useChat("tok", 0, { ioFactory: f.ioFactory }));
    const s = f.sockets[0]!;
    act(() => s.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    s.ackResponder = () => ({ ok: true, data: { sessionId: sid2, turns: [], hasMore: false } });
    await act(async () => {
      await result.current.newSession();
    });
    expect(result.current.session).toEqual({ kind: "ready", sessionId: sid2 });
    expect(sessionStorage.getItem(KEY)).toBe(sid2);
  });

  it("[P2] 로그아웃(토큰 제거)하면 저장값 삭제", async () => {
    const f = factory();
    const { result, rerender } = renderHook(({ tok, epoch }) => useChat(tok, epoch, { ioFactory: f.ioFactory }), {
      initialProps: { tok: "tok" as string | null, epoch: 0 },
    });
    act(() => f.sockets[0]!.serverEmit("connect"));
    await waitFor(() => expect(result.current.session.kind).toBe("ready"));
    expect(sessionStorage.getItem(KEY)).toBe(sid);
    rerender({ tok: null, epoch: 1 });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("[P2] 토큰 교체(authEpoch 변경)는 이전 저장값으로 resume하지 않는다", async () => {
    sessionStorage.setItem(KEY, sid);
    const f = factory();
    const { rerender } = renderHook(({ epoch }) => useChat("tok", epoch, { ioFactory: f.ioFactory }), { initialProps: { epoch: 0 } });
    rerender({ epoch: 1 });
    expect(sessionStorage.getItem(KEY)).toBeNull();
    act(() => f.sockets[1]!.serverEmit("connect"));
    await waitFor(() => expect(f.sockets[1]!.emitted).toHaveLength(1));
    expect(f.sockets[1]!.emitted[0]).toEqual({ event: "session:start", payload: {} });
  });
});
