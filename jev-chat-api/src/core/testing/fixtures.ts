import type { Chunk, Faq } from "../domain/types";

export function chunkFixture(p: Partial<Chunk> & Pick<Chunk, "id">): Chunk {
  return {
    module: "공통",
    kind: "regulation",
    title: "규정",
    section: "조항",
    text: "본문",
    tags: [],
    updatedAt: "2026-01-01",
    contentHash: `hash-${p.id}`,
    ...p,
  };
}

export function faqFixture(p: Partial<Faq> & Pick<Faq, "id">): Faq {
  return {
    intent: "regulation",
    summary: "요약",
    appliesWhen: "해당 질문",
    answer: "답변",
    sourceChunkId: null,
    variants: [],
    ...p,
  };
}
