export interface LimiterConfig {
  maxConcurrent: number;
  maxRequestsPerSecond: number;
  maxTokensPerSecond: number;
  maxWaitMs: number;
}

export type LimiterRejectReason = "timeout" | "oversized" | "aborted";

export class LimiterRejectedError extends Error {
  constructor(readonly reason: LimiterRejectReason, message = "Jev 제한기 대기 시간 초과") {
    super(message);
    this.name = "LimiterRejectedError";
  }
}

interface Waiter {
  tokens: number;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const WINDOW_MS = 1000;
const POLL_MS = 10;

/** 같은 API 키를 쓰는 모든 Jev 호출이 통과하는 단일 프로세스 제한기 (FIFO). */
export class JevLimiter {
  private active = 0;
  private readonly window: { at: number; tokens: number }[] = [];
  private readonly queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: LimiterConfig, private readonly now: () => number = () => Date.now()) {}

  stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }

  acquire(estimatedTokens: number, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new LimiterRejectedError("aborted", "이미 취소된 요청"));
    // [P1] 요청 하나가 초당 토큰 예산보다 크면 기다려도 통과할 수 없으므로 즉시 거절한다.
    if (estimatedTokens > this.config.maxTokensPerSecond) {
      return Promise.reject(new LimiterRejectedError("oversized", "요청 추정 토큰이 초당 예산보다 큼"));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.remove(waiter);
        reject(new LimiterRejectedError("aborted", "대기 중 취소됨"));
      };
      const waiter: Waiter = {
        tokens: estimatedTokens,
        enqueuedAt: this.now(),
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  private remove(waiter: Waiter): void {
    const i = this.queue.indexOf(waiter);
    if (i >= 0) this.queue.splice(i, 1);
    waiter.cleanup();
  }

  private prune(now: number): void {
    while (this.window.length > 0 && now - this.window[0]!.at >= WINDOW_MS) this.window.shift();
  }

  private canStart(tokens: number, now: number): boolean {
    this.prune(now);
    const usedTokens = this.window.reduce((s, w) => s + w.tokens, 0);
    return (
      this.active < this.config.maxConcurrent &&
      this.window.length < this.config.maxRequestsPerSecond &&
      usedTokens + tokens <= this.config.maxTokensPerSecond
    );
  }

  private pump(): void {
    const now = this.now();
    // 기한이 지난 대기자 거절
    for (const w of [...this.queue]) {
      if (now - w.enqueuedAt > this.config.maxWaitMs) {
        this.remove(w);
        w.reject(new LimiterRejectedError("timeout"));
      }
    }
    // FIFO로 시작 가능한 만큼 시작
    while (this.queue.length > 0 && this.canStart(this.queue[0]!.tokens, now)) {
      const w = this.queue.shift()!;
      w.cleanup();
      this.active++;
      this.window.push({ at: now, tokens: w.tokens });
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.queue.length === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, POLL_MS);
    this.timer.unref?.();
  }
}
