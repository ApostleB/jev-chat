import { describe, expect, it } from "vitest";
import { buildContext, buildQueries } from "./context";

const opts = { maxTurns: 2, assistantMaxChars: 10 };

describe("buildContext", () => {
  it("최근 maxTurns개 턴을 user/assistant 순서로 펼친다", () => {
    const ctx = buildContext(
      [
        { turnSeq: 1, userText: "u1", assistantText: "a1", sourceTitles: [] },
        { turnSeq: 2, userText: "u2", assistantText: "a2", sourceTitles: ["법인카드 규정"] },
        { turnSeq: 3, userText: "u3", assistantText: "a3", sourceTitles: ["경비 정산 사용법"] },
      ],
      opts,
    );
    expect(ctx.recentTurns).toEqual([
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ]);
    expect(ctx.turnSeqs).toEqual([2, 3]);
    expect(ctx.previousUserText).toBe("u3");
    expect(ctx.previousSourceTitles).toEqual(["경비 정산 사용법"]);
  });
  it("assistant 답변을 최대 길이로 자른다(코드포인트 기준)", () => {
    const ctx = buildContext([{ turnSeq: 1, userText: "u", assistantText: "가".repeat(20), sourceTitles: [] }], opts);
    expect(ctx.recentTurns[1]?.text).toBe("가".repeat(10) + "…");
  });
  it("턴이 없으면 빈 문맥", () => {
    expect(buildContext([], opts)).toEqual({ recentTurns: [], turnSeqs: [], previousUserText: null, previousSourceTitles: [] });
  });
});

describe("buildQueries", () => {
  it("이전 턴이 없으면 문서 질의는 현재 메시지 하나", () => {
    const q = buildQueries("법인카드 한도", buildContext([], opts));
    expect(q).toEqual({ faq: "법인카드 한도", chunks: ["법인카드 한도"] });
  });
  it("이전 턴이 있으면 q2에 이전 질문과 출처 제목을 더한다", () => {
    const ctx = buildContext([{ turnSeq: 1, userText: "경비 정산 어디서 해요", assistantText: "a", sourceTitles: ["경비 정산 사용법"] }], opts);
    const q = buildQueries("거기서 취소는요?", ctx);
    expect(q.faq).toBe("거기서 취소는요?");
    expect(q.chunks).toEqual(["거기서 취소는요?", "거기서 취소는요? 경비 정산 어디서 해요 경비 정산 사용법"]);
  });
});
