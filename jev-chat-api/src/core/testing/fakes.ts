import { DEFAULT_POLICY } from "../domain/policy";
import type { Chunk, CompletedTurn, Faq, IntentId, Policy } from "../domain/types";
import type { KnowledgeReader } from "../answer/extractive";
import type { ContextReader, ExecutionSnapshot } from "../engine/chat-engine";
import type { Judge, JudgeOutcome, RelevanceRequest, TurnJudgeRequest, TurnJudgment } from "../judge/ports";
import { DEFAULT_INTENTS, TEMPLATE_VERSION } from "../judge/templates";
import { Bm25Retriever } from "../retrieval/retriever";

type TurnFn = (req: TurnJudgeRequest, signal: AbortSignal) => Promise<JudgeOutcome<TurnJudgment>>;
type RelFn = (req: RelevanceRequest, signal: AbortSignal) => Promise<JudgeOutcome<number>>;

export class FakeJudge implements Judge {
  readonly turnCalls: TurnJudgeRequest[] = [];
  readonly relevanceCalls: RelevanceRequest[] = [];
  readonly abortedRelevance: string[] = [];
  constructor(private readonly onTurn: TurnFn, private readonly onRelevance: RelFn) {}

  judgeTurn(req: TurnJudgeRequest, signal: AbortSignal) {
    this.turnCalls.push(req);
    return this.onTurn(req, signal);
  }
  judgeRelevance(req: RelevanceRequest, signal: AbortSignal) {
    this.relevanceCalls.push(req);
    signal.addEventListener("abort", () => this.abortedRelevance.push(req.chunk.id), { once: true });
    return this.onRelevance(req, signal);
  }
}

export function probs(p: Partial<Record<IntentId, number>>): Record<IntentId, number> {
  return { regulation: 0, how_to: 0, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0, ...p };
}

export function okTurn(
  p: Partial<Record<IntentId, number>>,
  opts: { ambiguity?: number; faq?: TurnJudgment["faq"]; inputTokens?: number } = {},
): JudgeOutcome<TurnJudgment> {
  const probabilities = probs(p);
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0] as IntentId;
  return {
    ok: true,
    value: { intent: { choice, probabilities, confidence: 0.9 }, ambiguity: opts.ambiguity ?? 0, faq: opts.faq ?? null },
    audit: { call: "turn", status: "ok", attempts: 1, latencyMs: 5, model: "jev-1.13.0", usage: { inputTokens: opts.inputTokens ?? 100, outputTokens: 10 } },
  };
}

export function failedTurn(): JudgeOutcome<TurnJudgment> {
  return { ok: false, errorKind: "provider", message: "529", audit: { call: "turn", status: "failed", attempts: 2, latencyMs: 5 } };
}

export function okRelevance(chunkId: string, value: number, inputTokens = 50): JudgeOutcome<number> {
  return { ok: true, value, audit: { call: "relevance", chunkId, status: "ok", attempts: 1, latencyMs: 5, usage: { inputTokens, outputTokens: 5 } } };
}

export function failedRelevance(chunkId: string): JudgeOutcome<number> {
  return { ok: false, errorKind: "provider", message: "429", audit: { call: "relevance", chunkId, status: "failed", attempts: 2, latencyMs: 5 } };
}

/** signal이 abort될 때까지 끝나지 않는 promise (abort되면 aborted 결과) */
export function hangUntilAbort<T>(signal: AbortSignal, onAbort: () => T): Promise<T> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(onAbort()), { once: true }));
}

export class InMemoryKnowledge implements KnowledgeReader {
  constructor(readonly versionId: string, private readonly chunks: Chunk[], private readonly faqs: Faq[]) {}
  getChunk(id: string) {
    return this.chunks.find((c) => c.id === id);
  }
  getFaq(id: string) {
    return this.faqs.find((f) => f.id === id);
  }
}

export class InMemoryContextReader implements ContextReader {
  constructor(private readonly turns: CompletedTurn[] = []) {}
  async loadCompletedTurns(_sessionId: string, beforeTurnSeq: number, limit: number) {
    return this.turns.filter((t) => t.turnSeq < beforeTurnSeq).slice(-limit);
  }
}

export function makeSnapshot(opts: { chunks: Chunk[]; faqs: Faq[]; policy?: Policy; versionId?: string }): ExecutionSnapshot {
  const versionId = opts.versionId ?? "v1";
  return {
    knowledgeVersionId: versionId,
    policy: opts.policy ?? DEFAULT_POLICY,
    intents: DEFAULT_INTENTS,
    helpdesk: { phone: "02-000-0000", email: "help@hanbit.example" },
    templateVersion: TEMPLATE_VERSION,
    retriever: new Bm25Retriever(opts.faqs, opts.chunks),
    knowledge: new InMemoryKnowledge(versionId, opts.chunks, opts.faqs),
  };
}
