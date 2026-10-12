import { afterEach, describe, expect, it } from "vitest";
import { clearToken, getToken, setToken } from "./token-store";

describe("token-store", () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  it("sessionStorage에만 저장하고 지운다", () => {
    setToken("abc");
    expect(getToken()).toBe("abc");
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
    clearToken();
    expect(getToken()).toBeNull();
  });
  it("공백 토큰은 저장하지 않는다", () => {
    setToken("   ");
    expect(getToken()).toBeNull();
  });
});
