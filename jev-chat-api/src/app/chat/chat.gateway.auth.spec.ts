import { EventEmitter } from "node:events";
import { Server, Socket } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS } from "../auth/expiry";
import type { AuthedPrincipal } from "../auth/auth.types";
import { ChatGateway } from "./chat.gateway";

/**
 * 인증 미들웨어만 떼어 실제 socket.io Socket 객체(네트워크 없음)로 검증한다.
 * 실제 Socket은 미들웨어가 성공하기 전까지 connected=false(disconnected=true)다 — 정상 연결도 이 시점엔 disconnected다.
 */
function setup(principal: AuthedPrincipal | null | (() => Promise<AuthedPrincipal | null>)) {
  const auth = { verify: typeof principal === "function" ? principal : async () => principal };
  const gw = new ChatGateway({} as never, auth);
  let mw!: (socket: Socket, next: (e?: Error) => void) => void;
  gw.afterInit({ use: (fn: typeof mw) => (mw = fn) } as never);
  const server = new Server(); // listen 없음
  const nsp = server.of("/chat");
  const conn = Object.assign(new EventEmitter(), { readyState: "open", protocol: 4, remoteAddress: "local" });
  conn.once("close", () => (conn.readyState = "closed")); // engine.io Socket과 같은 상태 전이
  const client = { conn, request: { headers: {}, connection: {}, url: "/", _query: {} }, _packet: () => {} };
  const socket = new Socket(nsp, client as never, { token: "t", protocolVersion: 1 });
  const disconnect = vi.spyOn(socket, "disconnect").mockReturnValue(socket);
  /** 네임스페이스가 미들웨어 성공 뒤 하는 일 */
  const finishConnect = () => {
    socket.connected = true;
  };
  const run = () => new Promise<Error | undefined>((resolve) => mw(socket, resolve));
  return { socket, conn, disconnect, finishConnect, run };
}

describe("ChatGateway 인증 만료 타이머", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("expiresAt=%s → UNAUTHORIZED, 타이머 없음", async (bad) => {
    const { run } = setup({ userId: "u", roles: ["user"], expiresAt: bad });
    expect((await run())?.message).toBe("UNAUTHORIZED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("이미 만료(남은 시간 ≤ 0) → UNAUTHORIZED", async () => {
    const { run } = setup({ userId: "u", roles: ["user"], expiresAt: 1_000_000 });
    expect((await run())?.message).toBe("UNAUTHORIZED");
  });

  it("[V1] 열린 전송에서 미래 만료 타이머가 유지되고, 연결 완료 후 만료 시각에 disconnect한다", async () => {
    const t = setup({ userId: "u", roles: ["user"], expiresAt: 1_005_000 });
    expect(t.socket.disconnected).toBe(true); // 실제 초기 상태
    expect(t.conn.readyState).toBe("open");
    expect(await t.run()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    t.finishConnect();
    vi.advanceTimersByTime(4_999);
    expect(t.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.disconnect).toHaveBeenCalledWith(true);
  });

  it("2^31-1ms 초과 만료는 연결 직후 끊기지 않고 재무장해 만료 시각에 끊는다", async () => {
    const extra = 60_000;
    const t = setup({ userId: "u", roles: ["user"], expiresAt: 1_000_000 + MAX_TIMER_MS + extra });
    expect(await t.run()).toBeUndefined();
    t.finishConnect();
    vi.advanceTimersByTime(10);
    expect(t.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS - 10);
    expect(t.disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // 재무장
    vi.advanceTimersByTime(extra);
    expect(t.disconnect).toHaveBeenCalledWith(true);
  });

  it("만료 시각이 되면 연결을 끊고, 연결 종료 시 타이머를 해제한다", async () => {
    const b = setup({ userId: "u", roles: ["user"], expiresAt: 1_010_000 });
    await b.run();
    b.finishConnect();
    expect(vi.getTimerCount()).toBe(1);
    (b.socket as unknown as { emitReserved(ev: string, ...a: unknown[]): void }).emitReserved("disconnect", "client namespace disconnect");
    expect(vi.getTimerCount()).toBe(0);
    expect(b.conn.listenerCount("close")).toBe(1); // 테스트 소켓 자신의 상태 전이 리스너만 남는다
    expect(b.socket.listenerCount("disconnect")).toBe(0);
  });

  it("인증 도중 연결이 끊기면 타이머를 남기지 않는다", async () => {
    let finish!: (p: AuthedPrincipal) => void;
    const t = setup(() => new Promise<AuthedPrincipal | null>((r) => (finish = r)));
    const pending = t.run();
    t.conn.emit("close"); // verify 대기 중 전송 계층 종료
    finish({ userId: "u", roles: ["user"], expiresAt: 1_005_000 });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(t.conn.listenerCount("close")).toBe(0); // 상태 전이 리스너(once)까지 소진, 게이트웨이 리스너 없음
    expect(t.socket.listenerCount("disconnect")).toBe(0);
  });
});
