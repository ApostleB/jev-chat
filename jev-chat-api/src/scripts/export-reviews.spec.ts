import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INTENT_IDS } from "../core";
import { buildExportItem, type ContextTurnLike, type ReviewLike } from "./export-reviews.lib";

/** 계획 3 EvalItemSchema(Task 2)의 expect 규칙 중 export가 지켜야 하는 부분을 그대로 옮긴 계약 검사 */
const Outcome = z.enum(["ANSWER", "REFERENCE", "HOLD", "BLOCK", "ERROR"]);
const Ids = z.array(z.string().min(1));
const ReadyItem = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  type: z.enum(["followup", "from_review"]),
  turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1), sources: Ids.optional() })),
  message: z.string().min(1).max(1000),
  expect: z.object({
    intent: z.enum(INTENT_IDS).optional(), // null 금지, 생략만 허용
    allowed_outcomes: z.array(Outcome).min(1),
    faq_ids: Ids.optional(),
    acceptable_chunk_ids: Ids.optional(),
    required_chunk_ids_any: Ids.optional(),
    attack_goal: z.null(),
  }),
});

const review = (over: Omit<Partial<ReviewLike>, "trace"> & { trace?: Partial<ReviewLike["trace"]> } = {}): ReviewLike => ({
  id: "00000000-0000-4000-8000-000000000001",
  verdict: "correct",
  expectedIntent: null,
  expectedFaqId: null,
  expectedChunkIds: null,
  note: null,
  ...over,
  trace: {
    route: "faq", intent: "regulation", faqChoice: "faq-card", knowledgeVersionId: "v1", data: { contextTurnSeqs: [] },
    turn: { userText: "법인카드 한도", sources: [{ chunkId: "card-1" }] },
    ...over.trace,
  },
});
const ctx: ContextTurnLike[] = [{ userText: "이전 질문", assistantText: "이전 답", sources: [{ chunkId: "card-1" }] }];

describe("buildExportItem (평가 스키마 계약)", () => {
  it("의도를 판정하지 못한 route=error 턴의 correct 검수는 ready이되 expect.intent를 생략한다(null 아님)", () => {
    const { ready, item } = buildExportItem(review({ trace: { route: "error", intent: null, faqChoice: null, turn: { userText: "법인카드 한도", sources: [] } } }), []);
    expect(ready).toBe(true);
    const parsed = ReadyItem.parse(item);
    expect("intent" in parsed.expect).toBe(false);
    expect(parsed.expect.allowed_outcomes).toEqual(["ERROR"]);
    expect(JSON.stringify(item)).not.toContain('"intent":null');
  });

  it("정상 correct(faq): 검수자 의도 > trace 의도, FAQ·출처 라벨 포함", () => {
    const { ready, item } = buildExportItem(review({ expectedIntent: "how_to" }), []);
    expect(ready).toBe(true);
    expect(ReadyItem.parse(item).expect).toMatchObject({ intent: "how_to", allowed_outcomes: ["ANSWER"], faq_ids: ["faq-card"], acceptable_chunk_ids: ["card-1"], required_chunk_ids_any: ["card-1"] });
    expect(ReadyItem.parse(buildExportItem(review(), []).item).expect.intent).toBe("regulation");
  });

  it("검수자가 지정한 의도가 INTENT_IDS 밖이면 라벨 필요(사람이 고친다)", () => {
    const { ready, item } = buildExportItem(review({ expectedIntent: "weird" }), []);
    expect(ready).toBe(false);
    expect(item).not.toHaveProperty("expect");
    expect(item).toMatchObject({ review: { verdict: "correct" } });
  });

  it("문맥이 일부 사라졌으면 라벨 필요(contextComplete=false), 문맥이 온전하면 followup으로 복원", () => {
    const missing = buildExportItem(review({ trace: { data: { contextTurnSeqs: [1, 2] } } }), ctx);
    expect(missing.ready).toBe(false);
    expect(missing.item).toMatchObject({ review: { contextComplete: false } });
    expect(missing.item).not.toHaveProperty("expect");

    const complete = buildExportItem(review({ trace: { data: { contextTurnSeqs: [1] } } }), ctx);
    expect(complete.ready).toBe(true);
    const parsed = ReadyItem.parse(complete.item);
    expect(parsed.type).toBe("followup");
    expect(parsed.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(parsed.turns[1]?.sources).toEqual(["card-1"]);
  });

  it("wrong/partial: 정답 FAQ 또는 청크가 있으면 ANSWER 라벨로 ready, 둘 다 없으면 라벨 필요", () => {
    const withFaq = buildExportItem(review({ verdict: "wrong", expectedFaqId: "faq-meal" }), []);
    expect(withFaq.ready).toBe(true);
    expect(ReadyItem.parse(withFaq.item).expect).toMatchObject({ allowed_outcomes: ["ANSWER"], faq_ids: ["faq-meal"] });

    const withChunks = buildExportItem(review({ verdict: "partial", expectedChunkIds: ["card-2"] }), []);
    expect(withChunks.ready).toBe(true);
    expect(ReadyItem.parse(withChunks.item).expect).toMatchObject({ acceptable_chunk_ids: ["card-2"], required_chunk_ids_any: ["card-2"] });

    const none = buildExportItem(review({ verdict: "wrong", note: "정답 모름" }), []);
    expect(none.ready).toBe(false);
    expect(none.item).toMatchObject({ review: { verdict: "wrong", note: "정답 모름", route: "faq", contextComplete: true } });
    expect(buildExportItem(review({ verdict: "partial", expectedChunkIds: [] }), []).ready).toBe(false);
  });

  it("wrong 라벨의 의도도 null을 기록하지 않는다", () => {
    const { item } = buildExportItem(review({ verdict: "wrong", expectedFaqId: "faq-meal", trace: { intent: null } }), []);
    expect(ReadyItem.parse(item).expect).not.toHaveProperty("intent");
  });
});
