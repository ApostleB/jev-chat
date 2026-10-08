import type { Chunk, Faq, KnowledgeReader } from "../../core";

export class MapKnowledgeReader implements KnowledgeReader {
  private readonly chunks: Map<string, Chunk>;
  private readonly faqs: Map<string, Faq>;
  constructor(readonly versionId: string, chunks: Chunk[], faqs: Faq[]) {
    this.chunks = new Map(chunks.map((c) => [c.id, c]));
    this.faqs = new Map(faqs.map((f) => [f.id, f]));
  }
  getChunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }
  getFaq(id: string): Faq | undefined {
    return this.faqs.get(id);
  }
}
