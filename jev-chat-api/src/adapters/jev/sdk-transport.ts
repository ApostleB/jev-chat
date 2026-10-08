import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { JevResponseError, type JevRequest } from "../../core";
import { JevTransportError, type JevTransport, type JevTransportResult } from "./transport";

export interface SdkLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** [P2] retry-after-ms(밀리초) → Retry-After(초 또는 HTTP-date) 순으로 해석. 해석 불가·음수는 undefined. */
export function retryAfterFrom(headers: Headers | undefined, now: () => number = () => Date.now()): number | undefined {
  const ms = headers?.get("retry-after-ms");
  if (ms !== null && ms !== undefined) {
    const n = Number(ms);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

/** 알려진 SDK 오류만 매핑한다. [P3] 그 외(프로그래밍 오류 등)는 null → 원래 예외를 그대로 던진다. */
export function toTransportError(err: unknown, callerSignal: AbortSignal): JevTransportError | null {
  if (err instanceof APIUserAbortError) {
    // 시도 타임아웃은 우리 쪽 타이머(AbortController)로 구현되므로, 호출자 신호가 살아 있으면 timeout이다.
    return callerSignal.aborted ? new JevTransportError("aborted", "호출자가 취소함") : new JevTransportError("timeout", "시도 시간 초과");
  }
  if (err instanceof APITimeoutError) return new JevTransportError("timeout", "시도 시간 초과");
  if (err instanceof APIConnectionError) return new JevTransportError("connection", "연결 실패");
  if (err instanceof RateLimitError) {
    return new JevTransportError("rate_limited", "요청 한도 초과", { status: 429, retryAfterMs: err.retryAfterMs ?? retryAfterFrom(err.headers) });
  }
  if (err instanceof InternalServerError) {
    const kind = err.status === 529 ? "overloaded" : "server";
    return new JevTransportError(kind, `서버 오류 ${err.status}`, { status: err.status, retryAfterMs: retryAfterFrom(err.headers) });
  }
  if (err instanceof APIError) {
    // 408 등 기타 상태: 5xx가 아니면 client로 본다
    const kind = err.status >= 500 ? "server" : "client";
    return new JevTransportError(kind, `요청 오류 ${err.status}`, { status: err.status, retryAfterMs: retryAfterFrom(err.headers) });
  }
  return null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 200 응답의 형태 검증. 본문·헤더는 메시지에 담지 않는다. answers 내용은 core 파서가 검증한다. */
function checkShape(res: unknown): { model: string; answers: unknown; usage: { input_tokens: number; output_tokens: number } } {
  if (typeof res !== "object" || res === null) throw new JevResponseError("Jev 응답 형식 오류: 객체가 아님");
  const r = res as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } | null };
  if (typeof r.model !== "string") throw new JevResponseError("Jev 응답 형식 오류: model 누락");
  if (typeof r.usage !== "object" || r.usage === null || !isCount(r.usage.input_tokens) || !isCount(r.usage.output_tokens)) {
    throw new JevResponseError("Jev 응답 형식 오류: usage 누락 또는 잘못됨");
  }
  return { model: r.model, answers: r.answers, usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } };
}

export class SdkJevTransport implements JevTransport {
  private readonly client: TypeSafeClient;

  constructor(config: { apiKey: string; baseURL?: string; fetch?: typeof fetch; logger?: SdkLogger }) {
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.logger ? { logger: config.logger } : {}),
      logLevel: "warn",
      retry: { maxRetries: 0 },
    });
  }

  async send(payload: JevRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<JevTransportResult> {
    // 시도 타임아웃과 호출자 취소를 하나의 신호로 합친다(SDK timeout 옵션 대신 사용 — 구분을 우리가 한다).
    // AbortSignal.timeout()은 참조가 없으면 GC되어 발화하지 않을 수 있어, 직접 타이머와 컨트롤러를 쥔다.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), opts.timeoutMs);
    const attemptSignal = AbortSignal.any([opts.signal, timeoutCtrl.signal]);
    try {
      const res = await this.client.systemOne(
        { model: payload.model, state: payload.state as never, questions: payload.questions as never },
        { signal: attemptSignal, retry: { maxRetries: 0 } },
      );
      const checked = checkShape(res);
      return {
        model: checked.model,
        answers: checked.answers,
        usage: { inputTokens: checked.usage.input_tokens, outputTokens: checked.usage.output_tokens },
      };
    } catch (err) {
      throw toTransportError(err, opts.signal) ?? err;
    } finally {
      clearTimeout(timer);
    }
  }
}
