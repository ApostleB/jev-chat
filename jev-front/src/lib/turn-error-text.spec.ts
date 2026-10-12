import { ErrorCodeSchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import { turnErrorText } from "./turn-error-text";

describe("turnErrorText [S3]", () => {
  it.each(ErrorCodeSchema.options)("%s는 한국어 안내 문구로 매핑된다(코드 원문이 아님)", (code) => {
    const text = turnErrorText(code);
    expect(text).not.toBe(code);
    expect(text).not.toContain(code);
    expect(text).toMatch(/[가-힣]/);
  });
  it("RESTARTED", () => {
    expect(turnErrorText("RESTARTED")).toBe("서버가 다시 시작되어 처리가 중단되었습니다.");
  });
  it("알 수 없는 코드는 일반 문구 + 코드", () => {
    expect(turnErrorText("WEIRD")).toBe("처리 중 오류가 발생했습니다. (WEIRD)");
  });
});
