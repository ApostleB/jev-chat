import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./io.adapter";

describe("isAllowedOrigin [B5]", () => {
  const allowed = new Set(["http://localhost:5173"]);
  it("허용 목록의 Origin만 통과, Origin 없음(비브라우저)은 통과", () => {
    expect(isAllowedOrigin("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowedOrigin("http://evil.test", allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });
});
