/**
 * 세션 단위 동시성 제어 (단일 프로세스, PM2 fork instances:1 전제).
 * - withLock: 수락 임계 구역(멱등 조회 → 슬롯 예약 → DB 예약 → enqueue)을 직렬화
 * - tryReserve/release: 대기+처리 슬롯(capacity)
 * - run: 세션별 순차 실행
 */
export class SessionQueue {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly slots = new Map<string, number>();

  constructor(private readonly opts: { capacity: number }) {}

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }

  tryReserve(sessionId: string): boolean {
    const n = this.slots.get(sessionId) ?? 0;
    if (n >= this.opts.capacity) return false;
    this.slots.set(sessionId, n + 1);
    return true;
  }

  release(sessionId: string): void {
    const n = (this.slots.get(sessionId) ?? 0) - 1;
    if (n <= 0) this.slots.delete(sessionId);
    else this.slots.set(sessionId, n);
  }

  size(sessionId: string): number {
    return this.slots.get(sessionId) ?? 0;
  }

  run(sessionId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task).catch(() => undefined);
    this.chains.set(sessionId, next);
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
  }
}
