import { describe, expect, it } from "vitest";
import { Bm25Index } from "./bm25";

const docs = [
  { id: "a", text: "미사용 연차는 다음 해 3월 31일까지 최대 5일 이월할 수 있다" },
  { id: "b", text: "법인카드 1회 사용 한도는 50만 원이다" },
  { id: "c", text: "회식비는 1인당 5만 원을 넘을 수 없다 법인카드 사용" },
];

describe("Bm25Index", () => {
  const index = new Bm25Index(docs);

  it("관련 문서를 점수 순으로 돌려준다", () => {
    const hits = index.search("연차 이월", 3);
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.rank).toBe(1);
  });
  it("k개까지만 돌려준다", () => {
    expect(index.search("법인카드", 1)).toHaveLength(1);
  });
  it("점수 0인 문서는 제외한다", () => {
    expect(index.search("연차", 3).map((h) => h.id)).toEqual(["a"]);
  });
  it("공통 단어는 희귀 단어보다 가중치가 낮다", () => {
    const hits = index.search("법인카드 회식비", 3);
    expect(hits[0]?.id).toBe("c");
  });
  it("동점이면 입력 순서를 따른다", () => {
    const tie = new Bm25Index([
      { id: "x", text: "결재" },
      { id: "y", text: "결재" },
    ]);
    expect(tie.search("결재", 2).map((h) => h.id)).toEqual(["x", "y"]);
  });
  it("빈 질의·빈 인덱스는 빈 결과", () => {
    expect(index.search("", 3)).toEqual([]);
    expect(new Bm25Index([]).search("연차", 3)).toEqual([]);
  });
  it("rank는 1부터 연속된다", () => {
    expect(index.search("법인카드", 3).map((h) => h.rank)).toEqual([1, 2]);
  });
});
