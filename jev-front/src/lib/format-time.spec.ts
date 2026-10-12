import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format-time";

describe("formatDateTime [S4]", () => {
  it("ISO UTC를 지정 시간대의 YYYY-MM-DD HH:mm:ss로 바꾼다", () => {
    expect(formatDateTime("2026-10-12T16:17:04.012Z", "Asia/Seoul")).toBe("2026-10-13 01:17:04");
    expect(formatDateTime("2026-10-12T16:17:04.012Z", "UTC")).toBe("2026-10-12 16:17:04");
    expect(formatDateTime("2026-10-12T16:17:04.012Z", "America/New_York")).toBe("2026-10-12 12:17:04");
  });
  it("자정은 24시가 아니라 00시", () => {
    expect(formatDateTime("2026-10-12T15:00:00Z", "Asia/Seoul")).toBe("2026-10-13 00:00:00");
  });
  it("시간대를 생략하면 브라우저 로컬 시간대를 쓴다(형식만 확인)", () => {
    expect(formatDateTime("2026-10-12T16:17:04Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it("해석할 수 없는 값은 원문 그대로", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});
