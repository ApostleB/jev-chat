import { describe, expect, it } from "vitest";
import { DevAuthProvider } from "./dev-auth.provider";
import { StaticTokenAuthProvider } from "./static-auth.provider";
import { canAccessSession, hasRole } from "./access";

const TOKEN = "d".repeat(32);

describe("DevAuthProvider", () => {
  const p = new DevAuthProvider(TOKEN);
  it("일치하는 토큰은 공유 테스트 관리자 계정", async () => {
    expect(await p.verify(TOKEN)).toEqual({ userId: "dev-admin", roles: ["user", "debug", "admin"] });
  });
  it("불일치·길이 다름·빈 토큰은 null", async () => {
    expect(await p.verify("x".repeat(32))).toBeNull();
    expect(await p.verify(TOKEN + "x")).toBeNull();
    expect(await p.verify("")).toBeNull();
  });
  it("32자 미만 기대 토큰으로는 생성할 수 없다", () => {
    expect(() => new DevAuthProvider("short")).toThrow();
  });
});

describe("StaticTokenAuthProvider", () => {
  it("토큰별 principal", async () => {
    const p = new StaticTokenAuthProvider({ a: { userId: "alice", roles: ["user"] }, b: { userId: "bob", roles: ["user", "debug"] } });
    expect(await p.verify("a")).toEqual({ userId: "alice", roles: ["user"] });
    expect(await p.verify("zzz")).toBeNull();
  });
});

describe("access", () => {
  const alice = { userId: "alice", roles: ["user" as const] };
  const admin = { userId: "root", roles: ["user" as const, "admin" as const] };
  it("본인 세션만, admin은 전체", () => {
    expect(canAccessSession(alice, "alice")).toBe(true);
    expect(canAccessSession(alice, "bob")).toBe(false);
    expect(canAccessSession(admin, "bob")).toBe(true);
  });
  it("hasRole", () => {
    expect(hasRole(alice, "debug")).toBe(false);
    expect(hasRole(admin, "admin")).toBe(true);
  });
});
