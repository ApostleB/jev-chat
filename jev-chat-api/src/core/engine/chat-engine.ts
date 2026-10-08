import type { Answerer, KnowledgeReader } from "../answer/extractive";
import { buildContext, buildQueries } from "../context/context";
import type { CompletedTurn, Helpdesk, IntentDef, IntentId, Policy, Principal, Route, SourceRef } from "../domain/types";
import type { JevCallAudit, Judge, JudgeOutcome, TurnJudgment } from "../judge/ports";
import type { ChunkCandidate, Retriever } from "../retrieval/retriever";
import {
  decideFromRelevance,
  decideFromTurn,
  inScopeProbability,
  needsHelpdesk,
  type BStatus,
  type RouteDecision,
  type ScoredChunk,
} from "../routing/router";
import { linkedController, raceWithAbort } from "./abort";

export interface ContextReader {
  loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]>;
}

export interface ExecutionSnapshot {
  knowledgeVersionId: string;
  policy: Policy;
  intents: IntentDef[];
  helpdesk: Helpdesk;
  templateVersion: string;
  retriever: Retriever;
  knowledge: KnowledgeReader;
}

export interface HandleMessageInput {
  principal: Principal;
  sessionId: string;
  turnId: string;
  turnSeq: number;
  text: string;
  snapshot: ExecutionSnapshot;
  signal: AbortSignal;
}

export type Progress = { stage: "judging" | "answering" };

export interface CandidateTrace {
  kind: "faq" | "chunk";
  id: string;
  contentHash?: string;
  bm25Rank: number;
  bm25Score: number;
  relevance?: number;
  faqProb?: number;
  status?: "ok" | "failed" | "aborted" | "skipped";
}

export interface TraceRecord {
  knowledgeVersionId: string;
  templateVersion: string;
  model: string | null;
  policy: Policy;
  contextTurnSeqs: number[];
  intent: IntentId | null;
  intentProbs: Record<IntentId, number> | null;
  inScope: number | null;
  ambiguity: number | null;
  faqChoice: string | null;
  faqProb: number | null;
  faqConfidence: number | null;
  route: Route;
  retrieval: { faqQuery: string; chunkQueries: string[]; faqCandidateIds: string[]; chunkCandidateIds: string[] };
  candidates: CandidateTrace[];
  bStatus: BStatus;
  jevCalls: JevCallAudit[];
  latencyMs: { retrieval: number; turn: number | null; relevance: number | null; total: number };
  totalInputTokens: number;
  errorCode: "JEV_UNAVAILABLE" | null;
}

export interface EngineResult {
  route: Route;
  text: string;
  sources: SourceRef[];
  trace: TraceRecord;
}

export interface EngineDeps {
  judge: Judge;
  answerer: Answerer;
  contextReader: ContextReader;
  now?: () => number;
}

type RelevanceSettled = { candidate: ChunkCandidate; outcome: JudgeOutcome<number> | "aborted" };

export class ChatEngine {
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  async handle(input: HandleMessageInput, onProgress: (p: Progress) => void = () => {}): Promise<EngineResult> {
    const t0 = this.now();
    const { snapshot, signal } = input;
    const { policy } = snapshot;

    // ① 문맥 ② 후보
    // DB가 멈춰도 엔진 기한을 넘기지 않는다(abort되면 빈 문맥으로 진행 → A가 즉시 미완료 처리)
    const turns = await raceWithAbort(
      this.deps.contextReader.loadCompletedTurns(input.sessionId, input.turnSeq, policy.context.maxTurns),
      signal,
      () => [] as CompletedTurn[],
    );
    const ctx = buildContext(turns, policy.context);
    const queries = buildQueries(input.text, ctx);
    const faqCandidates = snapshot.retriever.searchFaqs(queries.faq, policy.candidates.faq);
    const chunkCandidates = snapshot.retriever.searchChunks(queries.chunks, policy.candidates.chunk);
    const tRetrieval = this.now();

    // ③ A와 B를 동시에 시작
    onProgress({ stage: "judging" });
    const bController = linkedController(signal);
    try {
      const turnStart = this.now();
      // 취소가 확정됐으면 외부 호출을 시작하지 않는다(A 미완료·B 미시작으로 결정 단계로 진행)
      const cancelled = signal.aborted;
      const turnPromise = cancelled
        ? null
        : this.deps.judge.judgeTurn(
            { message: input.text, recentTurns: ctx.recentTurns, faqCandidates, intents: snapshot.intents },
            signal,
          );
      let relevanceEnd: number | null = null;
      const relevancePromises: Promise<RelevanceSettled>[] = chunkCandidates.map((candidate) => {
      // 동기 throw도 rejection으로 바꿔 map이 끊기지 않게 한다(A와 B는 같은 동기 구간에서 시작)
      if (cancelled) return Promise.resolve<RelevanceSettled>({ candidate, outcome: "aborted" });
      const p = raceWithAbort<RelevanceSettled>(
        (async () => ({
          candidate,
          outcome: await this.deps.judge.judgeRelevance({ message: input.text, recentTurns: ctx.recentTurns, chunk: candidate.chunk }, bController.signal),
        }))(),
        bController.signal,
        () => ({ candidate, outcome: "aborted" }),
      );
      // 아무도 기다리지 않게 되어도 unhandledRejection이 생기지 않게 한다(Promise.all 경로는 그대로 전파)
      p.catch(() => {});
      return p;
    });

    const turnOutcome = (turnPromise ? await raceWithAbort<JudgeOutcome<TurnJudgment> | null>(turnPromise, signal, () => null) : null);
      const turnEnd = this.now();

      // ④ FAQ 조기 확정 / 종료 검사
      let decision: RouteDecision | null = decideFromTurn(policy, turnOutcome, faqCandidates);
      let settled: RelevanceSettled[] = [];
      let bStatus: BStatus;
      const earlyDecided = decision !== null;
      if (decision) {
        bController.abort();
        // 이미 끝난 B는 실제 결과로, 진행 중이던 B는 aborted로 trace에 남긴다
        settled = await Promise.all(relevancePromises);
        bStatus = chunkCandidates.length === 0 ? "empty" : "skipped";
      } else {
        settled = await Promise.all(relevancePromises);
        relevanceEnd = this.now();
        bStatus = this.bStatusOf(chunkCandidates.length, settled);
        const scored: ScoredChunk[] = settled.flatMap((s) =>
          s.outcome !== "aborted" && s.outcome.ok ? [{ candidate: s.candidate, relevance: s.outcome.value }] : [],
        );
        decision = decideFromRelevance(policy, scored, bStatus);
      }

      // ⑤ 답변
      onProgress({ stage: "answering" });
      const judgment = turnOutcome?.ok ? turnOutcome.value : null;
      const showHelpdesk = judgment ? needsHelpdesk(policy, judgment.intent.probabilities) : false;
      const answer = await this.deps.answerer.answer(
        { decision, helpdesk: snapshot.helpdesk, showHelpdesk, knowledge: snapshot.knowledge },
        signal,
      );

      const jevCalls: JevCallAudit[] = [
        ...(turnOutcome ? [turnOutcome.audit] : [this.unfinishedTurnAudit(signal, turnEnd - turnStart)]),
        ...settled.map((s) =>
          s.outcome === "aborted"
            ? this.unfinishedRelevanceAudit(s.candidate.chunk.id, signal, earlyDecided)
            : s.outcome.audit,
        ),
      ];
      const relevanceById = new Map(settled.map((s) => [s.candidate.chunk.id, s.outcome]));
      const faqProbs = judgment?.faq?.probabilities ?? {};

      const trace: TraceRecord = {
        knowledgeVersionId: snapshot.knowledgeVersionId,
        templateVersion: snapshot.templateVersion,
        model: turnOutcome?.audit.model ?? null,
        policy,
        contextTurnSeqs: ctx.turnSeqs,
        intent: judgment?.intent.choice ?? null,
        intentProbs: judgment?.intent.probabilities ?? null,
        inScope: judgment ? inScopeProbability(judgment.intent.probabilities) : null,
        ambiguity: judgment?.ambiguity ?? null,
        faqChoice: judgment?.faq?.choice ?? null,
        faqProb: judgment?.faq ? (judgment.faq.probabilities[judgment.faq.choice] ?? null) : null,
        faqConfidence: judgment?.faq?.confidence ?? null,
        route: decision.route,
        retrieval: {
          faqQuery: queries.faq,
          chunkQueries: queries.chunks,
          faqCandidateIds: faqCandidates.map((c) => c.faq.id),
          chunkCandidateIds: chunkCandidates.map((c) => c.chunk.id),
        },
        candidates: [
          ...faqCandidates.map((c) => ({
            kind: "faq" as const,
            id: c.faq.id,
            bm25Rank: c.bm25Rank,
            bm25Score: c.bm25Score,
            ...(c.faq.id in faqProbs ? { faqProb: faqProbs[c.faq.id] } : {}),
          })),
          ...chunkCandidates.map((c) => {
            const o = relevanceById.get(c.chunk.id);
            const base = { kind: "chunk" as const, id: c.chunk.id, contentHash: c.chunk.contentHash, bm25Rank: c.bm25Rank, bm25Score: c.bm25Score };
            if (o === undefined) return { ...base, status: "skipped" as const };
            if (o === "aborted") return { ...base, status: "aborted" as const };
            return o.ok ? { ...base, relevance: o.value, status: "ok" as const } : { ...base, status: "failed" as const };
          }),
        ],
        bStatus,
        jevCalls,
        latencyMs: {
          retrieval: tRetrieval - t0,
          turn: turnEnd - turnStart,
          relevance: relevanceEnd === null ? null : relevanceEnd - turnStart,
          total: this.now() - t0,
        },
        totalInputTokens: jevCalls.reduce((sum, c) => sum + (c.usage?.inputTokens ?? 0), 0),
        errorCode: decision.route === "error" ? "JEV_UNAVAILABLE" : null,
      };

      return { route: decision.route, text: answer.text, sources: answer.sources, trace };
    } finally {
      // 정상·예외 어느 쪽이든 남은 B 호출을 정리한다(이미 끝난 B에는 영향 없음)
      bController.abort();
    }
  }

  /** A가 끝나기 전 signal이 abort된 경우의 합성 audit. 기한 초과(TimeoutError)와 그 밖의 취소를 구분한다. */
  private unfinishedTurnAudit(signal: AbortSignal, latencyMs: number): JevCallAudit {
    const timedOut = (signal.reason as Error | undefined)?.name === "TimeoutError";
    return { call: "turn", status: timedOut ? "failed" : "aborted", attempts: 0, latencyMs, errorKind: timedOut ? "timeout" : "aborted" };
  }

  /** 미완료 B의 합성 audit. 엔진 기한 초과(TimeoutError)면 failed/timeout, FAQ 조기 확정 등 그 밖의 취소는 aborted. */
  private unfinishedRelevanceAudit(chunkId: string, signal: AbortSignal, earlyDecided: boolean): JevCallAudit {
    // FAQ 조기 확정은 우리가 B를 취소한 것이므로, 이후 기한이 지나도 timeout으로 기록하지 않는다
    const timedOut = !earlyDecided && (signal.reason as Error | undefined)?.name === "TimeoutError";
    return { call: "relevance", chunkId, status: timedOut ? "failed" : "aborted", attempts: 0, latencyMs: 0, errorKind: timedOut ? "timeout" : "aborted" };
  }

  private bStatusOf(count: number, settled: RelevanceSettled[]): BStatus {
    if (count === 0) return "empty";
    const ok = settled.filter((s) => s.outcome !== "aborted" && s.outcome.ok).length;
    if (ok === count) return "succeeded";
    if (ok === 0) return "failed";
    return "partial";
  }
}
