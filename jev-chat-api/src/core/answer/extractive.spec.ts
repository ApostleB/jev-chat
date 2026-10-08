import { describe, expect, it } from "vitest";
import { ExtractiveAnswerer, type KnowledgeReader } from "./extractive";
import { MESSAGES } from "./messages";
import { chunkFixture, faqFixture } from "../testing/fixtures";

const regChunk = chunkFixture({ id: "card-2", kind: "regulation", title: "법인카드 규정", section: "회식비", text: "회식비는 1인당 5만 원 이내", contentHash: "h2" });
const howChunk = chunkFixture({ id: "exp-1", kind: "how_to", title: "경비 정산 사용법", section: "취소", text: "상신 취소 버튼을 누른다", contentHash: "h3" });
const otherReg = chunkFixture({ id: "trip-1", kind: "regulation", title: "출장 규정", section: "식비", text: "출장 식비는 1일 3만 원", contentHash: "h4" });
const knowledge: KnowledgeReader = {
  versionId: "v1",
  getChunk: (id) => [regChunk, howChunk, otherReg].find((c) => c.id === id),
  getFaq: () => undefined,
};
const helpdesk = { phone: "02-000-0000", email: "help@hanbit.example" };
const signal = new AbortController().signal;
const answerer = new ExtractiveAnswerer();
const run = (decision: Parameters<typeof answerer.answer>[0]["decision"], showHelpdesk = false) =>
  answerer.answer({ decision, helpdesk, showHelpdesk, knowledge }, signal);

describe("ExtractiveAnswerer", () => {
  it("faq: 답변 + 규정 확인 안내 + source chunk 출처", async () => {
    const out = await run({ route: "faq", faq: faqFixture({ id: "f", answer: "회식비는 1인당 5만 원입니다.", sourceChunkId: "card-2" }) });
    expect(out.text).toBe(`회식비는 1인당 5만 원입니다.\n\n${MESSAGES.regulationNotice}`);
    expect(out.sources).toEqual([{ chunkId: "card-2", versionId: "v1", contentHash: "h2", title: "법인카드 규정", section: "회식비" }]);
  });
  it("faq: source가 없으면 출처·규정 안내 없음", async () => {
    const out = await run({ route: "faq", faq: faqFixture({ id: "f", answer: "답", sourceChunkId: null }) });
    expect(out).toEqual({ text: "답", sources: [] });
  });
  it("extractive(사용법 1개): 원문만, 규정 안내 없음", async () => {
    const out = await run({ route: "extractive", chunks: [howChunk] });
    expect(out.text).toBe("[경비 정산 사용법 · 취소]\n상신 취소 버튼을 누른다");
    expect(out.sources.map((s) => s.chunkId)).toEqual(["exp-1"]);
  });
  it("extractive(서로 다른 문서 2개): 여러 조항 안내 + 헬프데스크 + 규정 안내", async () => {
    const out = await run({ route: "extractive", chunks: [regChunk, otherReg] });
    expect(out.text).toContain("[법인카드 규정 · 회식비]");
    expect(out.text).toContain("[출장 규정 · 식비]");
    expect(out.text).toContain(MESSAGES.multipleProvisions);
    expect(out.text).toContain(MESSAGES.regulationNotice);
    expect(out.text).toContain(MESSAGES.helpdesk(helpdesk));
    expect(out.sources).toHaveLength(2);
  });
  it("reference: 안내 문구 + 1위 원문 + 담당부서 확인", async () => {
    const out = await run({ route: "reference", chunk: regChunk });
    expect(out.text.startsWith(MESSAGES.referenceIntro)).toBe(true);
    expect(out.text).toContain(MESSAGES.helpdesk(helpdesk));
    expect(out.sources).toHaveLength(1);
  });
  it("clarify/blocked/fallback/error: 고정 문구, 출처 없음", async () => {
    expect((await run({ route: "clarify", reason: "scope" })).text).toBe(MESSAGES.clarifyScope);
    expect((await run({ route: "clarify", reason: "ambiguous" })).text).toBe(MESSAGES.clarifyAmbiguous);
    expect((await run({ route: "blocked", variant: "smalltalk" })).text).toBe(MESSAGES.smalltalk);
    expect((await run({ route: "blocked", variant: "out_of_scope" })).text).toBe(MESSAGES.outOfScope);
    expect((await run({ route: "fallback" })).text).toBe(`${MESSAGES.fallback}\n\n${MESSAGES.helpdesk(helpdesk)}`);
    expect((await run({ route: "error", reason: "turn_failed" })).text).toBe(MESSAGES.error);
    expect((await run({ route: "fallback" })).sources).toEqual([]);
  });
  it("showHelpdesk면 답변 끝에 헬프데스크를 한 번만 붙인다", async () => {
    const out = await run({ route: "extractive", chunks: [howChunk] }, true);
    expect(out.text.endsWith(MESSAGES.helpdesk(helpdesk))).toBe(true);
    const twice = await run({ route: "reference", chunk: regChunk }, true);
    expect(twice.text.split(MESSAGES.helpdesk(helpdesk)).length - 1).toBe(1);
  });
  it("blocked·error에는 showHelpdesk여도 헬프데스크를 붙이지 않는다", async () => {
    expect((await run({ route: "error", reason: "turn_failed" }, true)).text).toBe(MESSAGES.error);
  });

  it("clarify: showHelpdesk면 문구 뒤에 헬프데스크 안내(ambiguous·scope 모두)", async () => {
    const line = MESSAGES.helpdesk(helpdesk);
    expect((await run({ route: "clarify", reason: "ambiguous" }, true)).text).toBe(`${MESSAGES.clarifyAmbiguous}\n\n${line}`);
    expect((await run({ route: "clarify", reason: "scope" }, true)).text).toBe(`${MESSAGES.clarifyScope}\n\n${line}`);
  });
  it("blocked/error는 showHelpdesk여도 헬프데스크를 붙이지 않는다", async () => {
    expect((await run({ route: "blocked", variant: "out_of_scope" }, true)).text).toBe(MESSAGES.outOfScope);
    expect((await run({ route: "error", reason: "turn_failed" }, true)).text).toBe(MESSAGES.error);
  });
});
