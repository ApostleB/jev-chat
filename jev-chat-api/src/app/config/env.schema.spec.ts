import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.schema";

const base = {
  NODE_ENV: "development",
  TYPESAFE_API_KEY: "test-key",
  DB_HOST: "127.0.0.1",
  DB_USER: "jev",
  DB_PASSWORD: "pw",
  DB_NAME: "jev_chat",
  AUTH_MODE: "dev",
  DEV_ACCESS_TOKEN: "a".repeat(32),
};

describe("validateEnv", () => {
  it("기본값을 채운다", () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.DB_PORT).toBe(3306);
    expect(env.JEV_MAX_CONCURRENT).toBe(40);
    expect(env.JEV_MAX_RPS).toBe(70);
    expect(env.JEV_MAX_TPS).toBe(80000);
    expect(env.JEV_ATTEMPT_TIMEOUT_MS).toBe(5000);
    expect(env.JEV_LIMITER_WAIT_MS).toBe(3000);
    expect(env.JEV_MAX_RETRY_WAIT_MS).toBe(2000);
    expect(env.RETENTION_DAYS).toBe(90);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(env.DOMAIN_PACK_DIR).toBe("domain-pack/hanbit-erp");
  });
  it("숫자 문자열을 숫자로 바꾼다", () => {
    expect(validateEnv({ ...base, PORT: "4000", DB_PORT: "3307" })).toMatchObject({ PORT: 4000, DB_PORT: 3307 });
  });
  it("CORS_ORIGINS는 쉼표로 나눈다", () => {
    expect(validateEnv({ ...base, CORS_ORIGINS: "http://a.test, http://b.test" }).CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });
  it("TYPESAFE_API_KEY가 없으면 실패", () => {
    const { TYPESAFE_API_KEY: _omit, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/TYPESAFE_API_KEY/);
  });
  it("AUTH_MODE=dev인데 DEV_ACCESS_TOKEN이 32자 미만이면 실패", () => {
    expect(() => validateEnv({ ...base, DEV_ACCESS_TOKEN: "short" })).toThrow(/DEV_ACCESS_TOKEN/);
  });
  it("production에서 AUTH_MODE=dev면 시작을 거부한다", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "production" })).toThrow(/AUTH_MODE=dev/);
  });
  it("오류 메시지에 비밀 값이 들어가지 않는다", () => {
    expect.assertions(1);
    try {
      validateEnv({ ...base, DEV_ACCESS_TOKEN: "secret-short" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-short");
    }
  });
});
