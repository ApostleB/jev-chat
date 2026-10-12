import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api-client";
import { errorText } from "./api";

describe("errorText [P6]", () => {
  it("401/403은 안내 문구", () => {
    expect(errorText(new ApiRequestError(401, "UNAUTHORIZED", "x"))).toBe("토큰을 확인하세요.");
    expect(errorText(new ApiRequestError(403, "FORBIDDEN", "x"))).toBe("권한이 없습니다.");
  });
  it("429는 retryAfterMs를 초로 올림해 안내", () => {
    expect(errorText(new ApiRequestError(429, "RATE_LIMITED", "x", 1200))).toBe("요청이 많습니다. 2초 후 다시 시도하세요.");
  });
  it("503 + retryAfterMs도 재시도 안내(code와 무관하게 status로 판단)", () => {
    expect(errorText(new ApiRequestError(503, "JEV_UNAVAILABLE", "x", 3000))).toBe("서버가 바쁩니다. 3초 후 다시 시도하세요.");
  });
  it("retryAfterMs 없는 429/503은 잠시 후 안내, 그 외는 서버 메시지 대신 상태 기반 문구", () => {
    expect(errorText(new ApiRequestError(429, "RATE_LIMITED", "x"))).toBe("요청이 많습니다. 잠시 후 다시 시도하세요.");
    expect(errorText(new ApiRequestError(500, "INTERNAL", "요청 실패 (500)"))).toBe("요청 실패 (500)");
    expect(errorText(new Error("boom"))).toBe("알 수 없는 오류");
  });
});
