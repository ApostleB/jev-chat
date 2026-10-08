import type { JevRequest } from "../../core";

export interface JevTransportResult {
  model: string;
  answers: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export type JevTransportErrorKind = "rate_limited" | "overloaded" | "server" | "timeout" | "connection" | "aborted" | "client";

export class JevTransportError extends Error {
  status?: number;
  retryAfterMs?: number;
  constructor(readonly kind: JevTransportErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "JevTransportError";
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface JevTransport {
  send(payload: JevRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<JevTransportResult>;
}
