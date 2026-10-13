import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack } from "../adapters/knowledge/pack-loader";
import type { EvalItem } from "./eval-item";
import { buildOfflineSnapshot, ItemContextReader } from "./offline-snapshot";

const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

describe("오프라인 스냅샷", () => {
  it("검색 가능한 스냅샷, 전달받은 policy·템플릿 라벨 반영", async () => {
    const pack = await loadDomainPack(MINI);
    const snap = buildOfflineSnapshot(pack, { templateLang: "ko", limiterWaitMs: 3000, policy: { ...pack.policy, faq: 0.7 } });
    expect(snap.retriever.searchFaqs("법인카드 한도", 5)[0]?.faq.id).toBe("faq-card-limit");
    expect(snap.policy.faq).toBe(0.7);
    expect(snap.policy.deadlines.limiterMs).toBe(3000);
    expect(snap.templateVersion).toBe("v2-ko");
  });
  it("ItemContextReader: 완료 턴, 출처 ID → title/section", async () => {
    const pack = await loadDomainPack(MINI);
    const item = {
      id: "f", type: "followup", message: "그럼 회식비는요?",
      turns: [{ role: "user", text: "법인카드 한도?" }, { role: "assistant", text: "50만 원", sources: ["card-001"] }],
      expect: { allowed_outcomes: ["HOLD"], attack_goal: null },
    } as EvalItem;
    expect(await new ItemContextReader(item, pack).loadCompletedTurns("s", 99, 2)).toEqual([
      { turnSeq: 1, userText: "법인카드 한도?", assistantText: "50만 원", sources: [{ title: "법인카드 규정", section: "제3조 사용 한도" }] },
    ]);
  });
});
