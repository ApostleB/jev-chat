export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = () => Date.now()) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]!) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true };
  }
}
