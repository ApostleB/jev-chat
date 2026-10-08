import { describe, expect, it } from "vitest";
import { buildContext, buildQueries } from "./context";

const opts = { maxTurns: 2, assistantMaxChars: 10 };

describe("buildContext", () => {
  it("최근 maxTurns개 턴을 user/assistant 순서로 펼친다", () => {
    const ctx = buildContext(
      [
        { turnSeq: 1, userText: "u1", assistantText: "a1", sources: [] },
        { turnSeq: 2, userText: "u2", assistantText: "a2", sources: [{ title: "법인카드 규정", section: "한도" }] },
        { turnSeq: 3, userText: "u3", assistantText: "a3", sources: [{ title: "경비 정산 사용법", section: "정산 화면" }] },
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
    expect(ctx.previousSources).toEqual([{ title: "경비 정산 사용법", section: "정산 화면" }]);
  });
  it("assistant 답변을 최대 길이로 자른다(코드포인트 기준)", () => {
    const ctx = buildContext([{ turnSeq: 1, userText: "u", assistantText: "가".repeat(20), sources: [] }], opts);
    expect(ctx.recentTurns[1]?.text).toBe("가".repeat(10) + "…");
  });
  it("maxTurns가 0이면 빈 문맥", () => {
    const turns = [{ turnSeq: 1, userText: "u1", assistantText: "a1", sources: [] }];
    expect(buildContext(turns, { ...opts, maxTurns: 0 })).toEqual({ recentTurns: [], turnSeqs: [], previousUserText: null, previousSources: [] });
  });
  it("maxTurns가 음수여도 빈 문맥", () => {
    const turns = [{ turnSeq: 1, userText: "u1", assistantText: "a1", sources: [] }];
    expect(buildContext(turns, { ...opts, maxTurns: -1 }).turnSeqs).toEqual([]);
  });
  it("maxTurns가 1이면 마지막 1턴만", () => {
    const turns = [
      { turnSeq: 1, userText: "u1", assistantText: "a1", sources: [] },
      { turnSeq: 2, userText: "u2", assistantText: "a2", sources: [] },
    ];
    expect(buildContext(turns, { ...opts, maxTurns: 1 }).turnSeqs).toEqual([2]);
  });
  it("maxTurns가 턴 수보다 크면 전체", () => {
    const turns = [
      { turnSeq: 1, userText: "u1", assistantText: "a1", sources: [] },
      { turnSeq: 2, userText: "u2", assistantText: "a2", sources: [] },
    ];
    expect(buildContext(turns, { ...opts, maxTurns: 10 }).turnSeqs).toEqual([1, 2]);
  });
  it("정확히 최대 길이면 자르지 않고 '…'도 붙이지 않는다", () => {
    const ctx = buildContext([{ turnSeq: 1, userText: "u", assistantText: "가".repeat(10), sources: [] }], opts);
    expect(ctx.recentTurns[1]?.text).toBe("가".repeat(10));
  });
  it("턴이 없으면 빈 문맥", () => {
    expect(buildContext([], opts)).toEqual({ recentTurns: [], turnSeqs: [], previousUserText: null, previousSources: [] });
  });
});

describe("buildQueries", () => {
  it("이전 턴이 없으면 문서 질의는 현재 메시지 하나", () => {
    const q = buildQueries("법인카드 한도", buildContext([], opts));
    expect(q).toEqual({ faq: "법인카드 한도", chunks: ["법인카드 한도"] });
  });
  it("이전 턴이 있으면 q2에 이전 질문과 출처 제목을 더한다", () => {
    const ctx = buildContext([{ turnSeq: 1, userText: "경비 정산 어디서 해요", assistantText: "a", sources: [{ title: "경비 정산 사용법", section: "정산 화면" }] }], opts);
    const q = buildQueries("거기서 취소는요?", ctx);
    expect(q.faq).toBe("거기서 취소는요?");
    expect(q.chunks).toEqual(["거기서 취소는요?", "거기서 취소는요? 경비 정산 어디서 해요 경비 정산 사용법 정산 화면"]);
  });
  it("같은 title의 다른 section 중 직전 출처 절이 q2에 들어간다", () => {
    const ctx = buildContext(
      [{ turnSeq: 1, userText: "결재 취소", assistantText: "a", sources: [{ title: "전자결재 규정", section: "상신 취소" }] }],
      opts,
    );
    expect(buildQueries("그건 언제까지요?", ctx).chunks[1]).toContain("전자결재 규정 상신 취소");
  });
});
