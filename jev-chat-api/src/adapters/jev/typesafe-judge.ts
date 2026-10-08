import {
  buildRelevanceRequest,
  buildTurnRequest,
  estimateTokens,
  JevResponseError,
  parseRelevanceAnswer,
  parseTurnAnswers,
  type JevCallAudit,
  type JevRequest,
  type Judge,
  type JudgeErrorKind,
  type JudgeOutcome,
  type RelevanceRequest,
  type TurnJudgeRequest,
  type TurnJudgment,
} from "../../core";
import { JevLimiter, LimiterRejectedError } from "./limiter";
import { JevTransportError, type JevTransport } from "./transport";

const RETRYABLE = new Set(["rate_limited", "overloaded", "server", "timeout", "connection"]);
const DEFAULT_BACKOFF_MS = 300;

interface Deps {
  transport: JevTransport;
  limiter: JevLimiter;
  attemptTimeoutMs: number;
  /** [P2] Retry-After가 이보다 길면 재시도하지 않는다 */
  maxRetryWaitMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export class TypesafeJudge implements Judge {
  private readonly maxAttempts: number;
  private readonly maxRetryWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: Deps) {
    this.maxAttempts = deps.maxAttempts ?? 2;
    this.maxRetryWaitMs = deps.maxRetryWaitMs ?? 2000;
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? abortableSleep;
  }

  judgeTurn(req: TurnJudgeRequest, signal: AbortSignal): Promise<JudgeOutcome<TurnJudgment>> {
    const payload = buildTurnRequest(req);
    if (!payload) return Promise.resolve(this.tooLarge("turn"));
    const sentFaqIds = payload.questions.faq ? Object.keys(payload.questions.faq.criteria).filter((k) => k !== "none") : [];
    return this.call("turn", payload, (answers) => parseTurnAnswers(answers, sentFaqIds), signal);
  }

  judgeRelevance(req: RelevanceRequest, signal: AbortSignal): Promise<JudgeOutcome<number>> {
    const payload = buildRelevanceRequest(req);
    if (!payload) return Promise.resolve(this.tooLarge("relevance", req.chunk.id));
    return this.call("relevance", payload, parseRelevanceAnswer, signal, req.chunk.id);
  }

  private tooLarge<T>(call: "turn" | "relevance", chunkId?: string): JudgeOutcome<T> {
    const audit: JevCallAudit = { call, status: "failed", attempts: 0, latencyMs: 0, errorKind: "too_large", cause: { source: "size" }, ...(chunkId ? { chunkId } : {}) };
    return { ok: false, errorKind: "too_large", message: "요청 크기 한도 초과", audit };
  }

  private async call<T>(
    call: "turn" | "relevance",
    payload: JevRequest,
    parse: (answers: unknown) => T,
    signal: AbortSignal,
    chunkId?: string,
  ): Promise<JudgeOutcome<T>> {
    const started = this.now();
    const tokens = estimateTokens(payload.state) + estimateTokens(payload.questions);
    let attempts = 0;
    const fail = (errorKind: JudgeErrorKind, message: string, extra: Partial<JevCallAudit> = {}): JudgeOutcome<T> => ({
      ok: false,
      errorKind,
      message,
      audit: {
        call,
        status: errorKind === "aborted" ? "aborted" : "failed",
        attempts,
        latencyMs: this.now() - started,
        estimatedInputTokens: tokens,
        errorKind,
        ...(chunkId ? { chunkId } : {}),
        ...extra,
      },
    });

    while (attempts < this.maxAttempts) {
      if (signal.aborted) return fail("aborted", "취소됨");
      let release: () => void;
      try {
        release = await this.deps.limiter.acquire(tokens, signal);
      } catch (e) {
        if (signal.aborted) return fail("aborted", "취소됨", { cause: { source: "limiter", kind: "aborted" } });
        if (e instanceof LimiterRejectedError) return fail("provider", e.message, { cause: { source: "limiter", kind: e.reason } });
        throw e;
      }
      attempts++;
      try {
        const res = await this.deps.transport.send(payload, { signal, timeoutMs: this.deps.attemptTimeoutMs });
        release();
        try {
          const value = parse(res.answers);
          return {
            ok: true,
            value,
            audit: {
              call,
              status: "ok",
              attempts,
              latencyMs: this.now() - started,
              model: res.model,
              usage: res.usage,
              estimatedInputTokens: tokens,
              answer: res.answers,
              ...(chunkId ? { chunkId } : {}),
            },
          };
        } catch (e) {
          if (e instanceof JevResponseError) {
            return fail("invalid_response", e.message, { model: res.model, usage: res.usage, answer: res.answers, cause: { source: "response" } });
          }
          throw e;
        }
      } catch (e) {
        release();
        if (e instanceof JevResponseError) return fail("invalid_response", e.message, { cause: { source: "response" } });
        if (!(e instanceof JevTransportError)) throw e; // [P3] 알 수 없는 예외는 재시도하지 않고 위로 전달(내부 오류)
        const cause = { source: "transport" as const, kind: e.kind, ...(e.status !== undefined ? { status: e.status } : {}) };
        if (e.kind === "aborted") return fail("aborted", e.message, { cause });
        const wait = e.retryAfterMs ?? DEFAULT_BACKOFF_MS;
        const retryable = RETRYABLE.has(e.kind) && attempts < this.maxAttempts && wait <= this.maxRetryWaitMs;
        if (!retryable) return fail(e.kind === "timeout" ? "timeout" : "provider", e.message, { cause });
        await this.sleep(wait, signal);
        if (signal.aborted) return fail("aborted", "재시도 대기 중 취소됨", { cause });
      }
    }
    return fail("provider", "재시도 소진");
  }
}
