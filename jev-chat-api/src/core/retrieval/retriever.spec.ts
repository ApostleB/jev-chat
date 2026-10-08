import { describe, expect, it } from "vitest";
import { Bm25Retriever } from "./retriever";
import { chunkFixture, faqFixture } from "../testing/fixtures";

const chunks = [
  chunkFixture({ id: "leave-1", title: "취업규칙", section: "연차 이월", text: "미사용 연차는 다음 해 3월 31일까지 최대 5일 이월할 수 있다" }),
  chunkFixture({ id: "card-1", title: "법인카드 규정", section: "한도", text: "법인카드 1회 사용 한도는 50만 원이다" }),
  chunkFixture({ id: "card-2", title: "법인카드 규정", section: "회식비", text: "회식비는 1인당 5만 원 이내로 사용한다" }),
  chunkFixture({ id: "expense-ui", title: "경비 정산 사용법", section: "정산 취소", text: "경비 정산 화면에서 상신 취소 버튼을 누른다" }),
];
const faqs = [
  faqFixture({ id: "faq-leave", summary: "연차 이월 기한과 한도", variants: ["연차 남은 거 내년에 써도 돼?", "연차 이월 되나요"] }),
  faqFixture({ id: "faq-card", summary: "법인카드 1회 한도", variants: ["법인카드 한도 얼마예요"] }),
];

describe("Bm25Retriever.searchFaqs", () => {
  const r = new Bm25Retriever(faqs, chunks);
  it("summary와 variants를 함께 검색한다", () => {
    const hits = r.searchFaqs("연차 내년에 써도 되나", 5);
    expect(hits[0]?.faq.id).toBe("faq-leave");
    expect(hits[0]?.bm25Rank).toBe(1);
  });
});

describe("Bm25Retriever.searchChunks", () => {
  const r = new Bm25Retriever(faqs, chunks);
  it("질의 하나면 그 결과를 그대로 쓴다", () => {
    const hits = r.searchChunks(["법인카드 한도"], 8);
    expect(hits[0]?.chunk.id).toBe("card-1");
    expect(hits[0]?.matchedBy).toEqual(["q1"]);
  });
  it("두 질의 결과를 순위 교차로 병합하고 중복을 제거한다", () => {
    const hits = r.searchChunks(["회식비", "법인카드 한도 회식비"], 8);
    const ids = hits.map((h) => h.chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("card-2");
    const card2 = hits.find((h) => h.chunk.id === "card-2");
    expect(card2?.matchedBy).toEqual(["q1", "q2"]);
    expect(hits.map((h) => h.bm25Rank)).toEqual(hits.map((_, i) => i + 1));
  });
  it("k개로 자른다", () => {
    expect(r.searchChunks(["법인카드", "회식비 정산"], 2)).toHaveLength(2);
  });
  it("결과가 없으면 빈 배열", () => {
    expect(r.searchChunks(["zzz"], 8)).toEqual([]);
  });
});
