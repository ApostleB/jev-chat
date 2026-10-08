import { describe, expect, it } from "vitest";
// NestJS 없이 공개 API만으로 엔진을 조립해 실행한다.
import {
  Bm25Retriever,
  ChatEngine,
  DEFAULT_INTENTS,
  DEFAULT_POLICY,
  ExtractiveAnswerer,
  TEMPLATE_VERSION,
  type ContextReader,
  type ExecutionSnapshot,
  type Judge,
  type KnowledgeReader,
} from "./index";
import { chunkFixture, faqFixture } from "./testing/fixtures";

describe("core 단독 실행", () => {
  it("공개 API만으로 메시지 한 건을 처리한다", async () => {
    const chunks = [chunkFixture({ id: "approval-1", title: "전자결재 규정", section: "제4조", text: "100만 원 이상 500만 원 미만은 팀장과 본부장 결재" })];
    const faqs = [faqFixture({ id: "faq-approval", summary: "금액별 결재선", variants: ["300만원 결재 누구한테"], answer: "팀장과 본부장 결재입니다.", sourceChunkId: "approval-1" })];
    const knowledge: KnowledgeReader = {
      versionId: "v-test",
      getChunk: (id) => chunks.find((c) => c.id === id),
      getFaq: (id) => faqs.find((f) => f.id === id),
    };
    const snapshot: ExecutionSnapshot = {
      knowledgeVersionId: "v-test",
      policy: DEFAULT_POLICY,
      intents: DEFAULT_INTENTS,
      helpdesk: { phone: "02-000-0000", email: "help@hanbit.example" },
      templateVersion: TEMPLATE_VERSION,
      retriever: new Bm25Retriever(faqs, chunks),
      knowledge,
    };
    const judge: Judge = {
      judgeTurn: async () => ({
        ok: true,
        value: {
          intent: { choice: "regulation", confidence: 0.95, probabilities: { regulation: 0.95, how_to: 0.05, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0 } },
          ambiguity: 0.05,
          faq: { choice: "faq-approval", confidence: 0.9, probabilities: { "faq-approval": 0.9, none: 0.1 } },
        },
        audit: { call: "turn", status: "ok", attempts: 1, latencyMs: 1 },
      }),
      judgeRelevance: async (req) => ({ ok: true, value: 0.1, audit: { call: "relevance", chunkId: req.chunk.id, status: "ok", attempts: 1, latencyMs: 1 } }),
    };
    const contextReader: ContextReader = { loadCompletedTurns: async () => [] };
    const engine = new ChatEngine({ judge, answerer: new ExtractiveAnswerer(), contextReader });

    const result = await engine.handle({
      principal: { userId: "u", roles: ["user"] },
      sessionId: "s",
      turnId: "t",
      turnSeq: 1,
      text: "300만원 결재 누구한테 올려요?",
      snapshot,
      signal: AbortSignal.timeout(DEFAULT_POLICY.deadlines.engineMs),
    });

    expect(result.route).toBe("faq");
    expect(result.text).toContain("팀장과 본부장 결재입니다.");
    expect(result.sources[0]?.versionId).toBe("v-test");
    expect(JSON.parse(JSON.stringify(result.trace)).route).toBe("faq"); // trace는 JSON 직렬화 가능
  });
});
