import { MapKnowledgeReader } from "../adapters/knowledge/map-knowledge";
import type { DomainPack } from "../adapters/knowledge/pack-loader";
import { Bm25Retriever, templateVersionLabel, type CompletedTurn, type ContextReader, type ExecutionSnapshot, type Policy, type TemplateLang } from "../core";
import type { EvalItem } from "./eval-item";

export function buildOfflineSnapshot(pack: DomainPack, opts: { templateLang: TemplateLang; limiterWaitMs: number; policy: Policy }): ExecutionSnapshot {
  const versionId = `offline-${pack.contentHash.slice(0, 12)}`;
  return {
    knowledgeVersionId: versionId,
    policy: { ...opts.policy, deadlines: { ...opts.policy.deadlines, limiterMs: opts.limiterWaitMs } },
    intents: pack.intents,
    helpdesk: pack.manifest.helpdesk,
    templateVersion: templateVersionLabel(opts.templateLang),
    retriever: new Bm25Retriever(pack.faqs, pack.chunks),
    knowledge: new MapKnowledgeReader(versionId, pack.chunks, pack.faqs),
  };
}

/** 스키마가 교대·짝을 보장하므로 user/assistant 쌍을 그대로 완료 턴으로 만든다. 절단은 엔진의 buildContext가 운영과 동일하게 한다. */
export class ItemContextReader implements ContextReader {
  private readonly turns: CompletedTurn[];

  constructor(item: EvalItem, pack: DomainPack) {
    const byId = new Map(pack.chunks.map((c) => [c.id, c]));
    const turns: CompletedTurn[] = [];
    for (let i = 0; i + 1 < item.turns.length; i += 2) {
      const u = item.turns[i]!;
      const a = item.turns[i + 1]!;
      turns.push({
        turnSeq: turns.length + 1,
        userText: u.text,
        assistantText: a.text,
        sources: (a.sources ?? []).map((id) => {
          const c = byId.get(id)!; // loadEvalSet이 존재를 보장
          return { title: c.title, section: c.section };
        }),
      });
    }
    this.turns = turns;
  }

  async loadCompletedTurns(_sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]> {
    return this.turns.filter((t) => t.turnSeq < beforeTurnSeq).slice(-limit);
  }
}
