import { afterEach, describe, expect, it } from "vitest";
import { clearSessionId, getSessionId, setSessionId } from "./session-store";

const sid = "00000000-0000-4000-8000-000000000001";

describe("session-store [P2]", () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  it("sessionStorage에만 저장하고 지운다", () => {
    setSessionId(sid);
    expect(getSessionId()).toBe(sid);
    expect(sessionStorage.getItem("jev-chat.sessionId")).toBe(sid);
    expect(localStorage.length).toBe(0);
    clearSessionId();
    expect(getSessionId()).toBeNull();
  });
  it("대문자 UUID는 소문자로 정규화해 읽고, UUID가 아닌 값은 버린다 [P4]", () => {
    sessionStorage.setItem("jev-chat.sessionId", sid.toUpperCase());
    expect(getSessionId()).toBe(sid);
    sessionStorage.setItem("jev-chat.sessionId", "not-a-uuid");
    expect(getSessionId()).toBeNull();
  });
});
