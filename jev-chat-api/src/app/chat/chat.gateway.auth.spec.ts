import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS } from "../auth/expiry";
import type { AuthedPrincipal } from "../auth/auth.types";
import { ChatGateway } from "./chat.gateway";

/** 인증 미들웨어만 떼어 가짜 소켓으로 검증한다(소켓 만료 타이머 경계) */
function setup(principal: AuthedPrincipal | null | (() => Promise<AuthedPrincipal | null>)) {
  const auth = { verify: typeof principal === "function" ? principal : async () => principal };
  const gw = new ChatGateway({} as never, auth);
  let mw!: (socket: unknown, next: (e?: Error) => void) => void;
  gw.afterInit({ use: (fn: typeof mw) => (mw = fn) } as never);
  const socket = Object.assign(new EventEmitter(), {
    handshake: { auth: { token: "t", protocolVersion: 1 } },
    data: {} as Record<string, unknown>,
    conn: Object.assign(new EventEmitter(), { readyState: "open" }),
    disconnect: vi.fn(),
  });
  socket.conn.once("close", () => (socket.conn.readyState = "closed")); // engine.io Socket과 같은 상태 전이
  const run = () => new Promise<Error | undefined>((resolve) => mw(socket, resolve));
  return { socket, run };
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

  it("2^31-1ms 초과 만료는 연결 직후 끊기지 않는다", async () => {
    const { run, socket } = setup({ userId: "u", roles: ["user"], expiresAt: 1_000_000 + MAX_TIMER_MS + 60_000 });
    expect(await run()).toBeUndefined();
    vi.advanceTimersByTime(10);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("만료 시각이 되면 연결을 끊고, 연결 종료 시 타이머를 해제한다", async () => {
    const a = setup({ userId: "u", roles: ["user"], expiresAt: 1_005_000 });
    expect(await a.run()).toBeUndefined();
    vi.advanceTimersByTime(5_000);
    expect(a.socket.disconnect).toHaveBeenCalledWith(true);

    const b = setup({ userId: "u", roles: ["user"], expiresAt: 1_010_000 });
    await b.run();
    expect(vi.getTimerCount()).toBe(1);
    b.socket.emit("disconnect");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("인증 도중 연결이 끊기면 타이머를 남기지 않는다", async () => {
    let finish!: (p: AuthedPrincipal) => void;
    const { run, socket } = setup(() => new Promise<AuthedPrincipal | null>((r) => (finish = r)));
    const pending = run();
    socket.conn.emit("close"); // verify 대기 중 전송 계층 종료
    finish({ userId: "u", roles: ["user"], expiresAt: 1_005_000 });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
