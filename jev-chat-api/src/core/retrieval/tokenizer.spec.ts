import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenizer";

describe("tokenize", () => {
  it("한글 어절을 2글자 단위(bigram)로 쪼갠다", () => {
    expect(tokenize("연차는")).toEqual(["연차", "차는"]);
  });
  it("한 글자 한글 어절은 그대로 둔다", () => {
    expect(tokenize("팀 장")).toEqual(["팀", "장"]);
  });
  it("조사가 붙어도 공통 bigram이 생긴다", () => {
    const a = tokenize("연차");
    const b = tokenize("연차는");
    expect(b).toEqual(expect.arrayContaining(a));
  });
  it("영문·숫자는 소문자 단어 단위로 둔다", () => {
    expect(tokenize("HB-ERP 100만원")).toEqual(["hb", "erp", "100", "만원"]);
  });
  it("숫자와 한글이 붙어 있으면 분리한다", () => {
    expect(tokenize("300만원")).toEqual(["300", "만원"]);
  });
  it("구두점과 공백을 무시한다", () => {
    expect(tokenize("  결재선?! ")).toEqual(["결재", "재선"]);
  });
  it("빈 문자열은 빈 배열", () => {
    expect(tokenize("")).toEqual([]);
  });
});
