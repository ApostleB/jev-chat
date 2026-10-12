import { describe, expect, it } from "vitest";
import { ApiErrorSchema, PageSchema, ReviewRequestSchema, SessionSummarySchema } from "./index";

describe("REST DTO", () => {
  it("Page는 items와 nextCursor(없으면 null)", () => {
    const P = PageSchema(SessionSummarySchema);
    expect(P.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });
  it("검수 요청: verdict 필수, 메모 2000자 이하", () => {
    expect(ReviewRequestSchema.safeParse({ verdict: "wrong", expectedFaqId: "faq-a", note: "정답은 faq-a" }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ note: "x" }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ verdict: "correct", note: "가".repeat(2001) }).success).toBe(false);
  });
  it("API 오류 본문", () => {
    expect(ApiErrorSchema.parse({ error: { code: "FORBIDDEN", message: "권한이 없습니다." } }).error.code).toBe("FORBIDDEN");
    expect(ApiErrorSchema.parse({ error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 1500 } }).error.retryAfterMs).toBe(1500);
  });
});
