import { tokenize } from "./tokenizer";

export interface Bm25Hit {
  id: string;
  score: number;
  rank: number;
}

interface IndexedDoc {
  id: string;
  order: number;
  length: number;
  termFreq: Map<string, number>;
}

export class Bm25Index {
  private readonly docs: IndexedDoc[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(docs: { id: string; text: string }[], opts: { k1?: number; b?: number } = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.docs = docs.map((d, order) => {
      const tokens = tokenize(d.text);
      const termFreq = new Map<string, number>();
      for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      for (const t of termFreq.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      return { id: d.id, order, length: tokens.length, termFreq };
    });
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  search(query: string, k: number): Bm25Hit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0 || k <= 0) return [];
    const n = this.docs.length;
    const scored: { doc: IndexedDoc; score: number }[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = tf + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgLength || 1));
        score += idf * ((tf * (this.k1 + 1)) / norm);
      }
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((x, y) => y.score - x.score || x.doc.order - y.doc.order);
    return scored.slice(0, k).map((s, i) => ({ id: s.doc.id, score: s.score, rank: i + 1 }));
  }
}
