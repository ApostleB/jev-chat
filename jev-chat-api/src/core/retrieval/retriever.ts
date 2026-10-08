import type { Chunk, Faq } from "../domain/types";
import { Bm25Index, type Bm25Hit } from "./bm25";

export interface FaqCandidate {
  faq: Faq;
  bm25Rank: number;
  bm25Score: number;
}

export interface ChunkCandidate {
  chunk: Chunk;
  bm25Rank: number;
  bm25Score: number;
  matchedBy: ("q1" | "q2")[];
}

export interface Retriever {
  searchFaqs(query: string, k: number): FaqCandidate[];
  /** 최대 2개 질의(q1, q2)의 결과를 순위 교차 병합한다. */
  searchChunks(queries: string[], k: number): ChunkCandidate[];
}

export class Bm25Retriever implements Retriever {
  private readonly faqIndex: Bm25Index;
  private readonly chunkIndex: Bm25Index;
  private readonly faqById: Map<string, Faq>;
  private readonly chunkById: Map<string, Chunk>;

  constructor(faqs: Faq[], chunks: Chunk[]) {
    this.faqById = new Map(faqs.map((f) => [f.id, f]));
    this.chunkById = new Map(chunks.map((c) => [c.id, c]));
    this.faqIndex = new Bm25Index(faqs.map((f) => ({ id: f.id, text: [f.summary, ...f.variants].join(" ") })));
    this.chunkIndex = new Bm25Index(chunks.map((c) => ({ id: c.id, text: `${c.title} ${c.section} ${c.text}` })));
  }

  searchFaqs(query: string, k: number): FaqCandidate[] {
    return this.faqIndex.search(query, k).map((h) => ({
      faq: this.faqById.get(h.id)!,
      bm25Rank: h.rank,
      bm25Score: h.score,
    }));
  }

  searchChunks(queries: string[], k: number): ChunkCandidate[] {
    const labels = ["q1", "q2"] as const;
    const lists: Bm25Hit[][] = queries.slice(0, 2).map((q) => this.chunkIndex.search(q, k));
    const merged = new Map<string, { score: number; matchedBy: ("q1" | "q2")[] }>();
    const order: string[] = [];
    const maxLen = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < maxLen; i++) {
      lists.forEach((list, qi) => {
        const hit = list[i];
        if (!hit) return;
        const label = labels[qi]!;
        const existing = merged.get(hit.id);
        if (existing) {
          if (!existing.matchedBy.includes(label)) existing.matchedBy.push(label);
          existing.score = Math.max(existing.score, hit.score);
          return;
        }
        merged.set(hit.id, { score: hit.score, matchedBy: [label] });
        order.push(hit.id);
      });
    }
    return order.slice(0, k).map((id, i) => {
      const m = merged.get(id)!;
      m.matchedBy.sort();
      return { chunk: this.chunkById.get(id)!, bm25Rank: i + 1, bm25Score: m.score, matchedBy: m.matchedBy };
    });
  }
}
