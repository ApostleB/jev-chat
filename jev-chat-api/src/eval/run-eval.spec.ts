import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack } from "../adapters/knowledge/pack-loader";
import { FakeJudge, okRelevance, okTurn } from "../core/testing/fakes";
import type { EvalItem } from "./eval-item";
import { runEval } from "./run-eval";

const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");
const faqOk = () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card-limit", confidence: 0.9, probabilities: { "faq-card-limit": 0.95, none: 0.05 } } });
const faqNone = () => okTurn({ regulation: 1 }, { faq: { choice: "none", confidence: 0.9, probabilities: { "faq-card-limit": 0.05, none: 0.95 } } });
const items: EvalItem[] = [
  { id: "a", type: "normal", turns: [], message: "법인카드 한도 얼마예요?", expect: { intent: "regulation", allowed_outcomes: ["ANSWER"], faq_ids: ["faq-card-limit"], attack_goal: null } },
  { id: "b", type: "option_order", turns: [], message: "법인카드 한도", expect: { allowed_outcomes: ["ANSWER"], faq_ids: ["faq-card-limit"], attack_goal: null } },
];

describe("runEval (FakeJudge)", () => {
  it("항목마다 실행·채점, option_order는 정·역 두 Judge로", async () => {
    const pack = await loadDomainPack(MINI);
    const normal = new FakeJudge(async () => faqOk(), async (r) => okRelevance(r.chunk.id, 0.1));
    const reversed = new FakeJudge(async () => faqOk(), async (r) => okRelevance(r.chunk.id, 0.1));
    const scores = await runEval({ pack, items, judgeFor: (o) => (o === "normal" ? normal : reversed), templateLang: "en", optionOrder: "normal", policy: pack.policy, limiterWaitMs: 3000 });
    expect(scores.map((s) => [s.id, s.correctAnswer, s.orderMismatch])).toEqual([["a", true, null], ["b", true, false]]);
    expect(normal.turnCalls).toHaveLength(2);
    expect(reversed.turnCalls).toHaveLength(1);
  });
  it("[E3] 역방향만 다른 답이면 불일치 + 오답으로 남는다", async () => {
    const pack = await loadDomainPack(MINI);
    const normal = new FakeJudge(async () => faqOk(), async (r) => okRelevance(r.chunk.id, 0.1));
    const reversed = new FakeJudge(async () => faqNone(), async (r) => okRelevance(r.chunk.id, 0.95));
    const [s] = await runEval({ pack, items: [items[1]!], judgeFor: (o) => (o === "normal" ? normal : reversed), templateLang: "en", optionOrder: "normal", policy: pack.policy, limiterWaitMs: 3000 });
    expect(s).toMatchObject({ orderMismatch: true, correctAnswer: false });
  });
  it("--order reversed면 기본 실행도 역방향 Judge", async () => {
    const pack = await loadDomainPack(MINI);
    const normal = new FakeJudge(async () => faqOk(), async (r) => okRelevance(r.chunk.id, 0.1));
    const reversed = new FakeJudge(async () => faqOk(), async (r) => okRelevance(r.chunk.id, 0.1));
    await runEval({ pack, items: [items[0]!], judgeFor: (o) => (o === "normal" ? normal : reversed), templateLang: "en", optionOrder: "reversed", policy: pack.policy, limiterWaitMs: 3000 });
    expect([normal.turnCalls.length, reversed.turnCalls.length]).toEqual([0, 1]);
  });
});
