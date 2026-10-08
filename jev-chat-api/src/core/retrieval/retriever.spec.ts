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

describe("Bm25Retriever.searchFaqs 색인 필드", () => {
  const r = new Bm25Retriever(
    [
      faqFixture({ id: "only-summary", summary: "zebra", variants: ["다른 표현"] }),
      faqFixture({ id: "only-variant", summary: "다른 요약", variants: ["giraffe"] }),
    ],
    [],
  );
  it("summary에만 있는 단어로 검색된다", () => {
    expect(r.searchFaqs("zebra", 5).map((h) => h.faq.id)).toEqual(["only-summary"]);
  });
  it("variants에만 있는 단어로 검색된다", () => {
    expect(r.searchFaqs("giraffe", 5).map((h) => h.faq.id)).toEqual(["only-variant"]);
  });
  it("k=0이면 빈 배열", () => {
    expect(r.searchFaqs("zebra", 0)).toEqual([]);
  });
});

describe("Bm25Retriever.searchChunks 병합 순서 계약", () => {
  // 모든 문서가 같은 길이(title·section 포함 6토큰)라 점수는 tf로만 갈린다.
  //  q1="p" -> a,b,c가 동점(문서 순서) => [a,b,c]
  //  q2="r" -> tf: a=3, d=2, b=1 => [a,d,b]
  const mk = (id: string, text: string) => chunkFixture({ id, title: "t", section: "s", text });
  const r = new Bm25Retriever([], [mk("a", "p r r r"), mk("b", "p r q q"), mk("c", "p q q q"), mk("d", "o r r q")]);

  it("전제: 단독 질의 순서가 q1=[a,b,c], q2=[a,d,b]", () => {
    expect(r.searchChunks(["p"], 8).map((h) => h.chunk.id)).toEqual(["a", "b", "c"]);
    expect(r.searchChunks(["r"], 8).map((h) => h.chunk.id)).toEqual(["a", "d", "b"]);
  });
  it("순위 교차 병합 순서는 [a,b,d,c]이고 matchedBy를 합친다", () => {
    const hits = r.searchChunks(["p", "r"], 8);
    expect(hits.map((h) => h.chunk.id)).toEqual(["a", "b", "d", "c"]);
    expect(hits.map((h) => h.matchedBy)).toEqual([["q1", "q2"], ["q1", "q2"], ["q2"], ["q1"]]);
    expect(hits.map((h) => h.bm25Rank)).toEqual([1, 2, 3, 4]);
  });
  it("k=3으로 자르면 [a,b,d]", () => {
    expect(r.searchChunks(["p", "r"], 3).map((h) => h.chunk.id)).toEqual(["a", "b", "d"]);
  });
  it("k=0이면 빈 배열", () => {
    expect(r.searchChunks(["p", "r"], 0)).toEqual([]);
  });
});

describe("Bm25Retriever NFC 정규화", () => {
  it("분해형(NFD) 질의가 조합형 문서와 매칭된다", () => {
    const r = new Bm25Retriever([], [chunkFixture({ id: "h", title: "t", section: "s", text: "한글 입력 방법" })]);
    const decomposed = "한글".normalize("NFD");
    expect(decomposed).not.toBe("한글");
    expect([...decomposed].length).toBeGreaterThan(2); // 정말 자모로 분해되었는지
    expect(r.searchChunks([decomposed], 5).map((h) => h.chunk.id)).toEqual(["h"]);
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
