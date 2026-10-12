import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("useChat", () => {
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
});
