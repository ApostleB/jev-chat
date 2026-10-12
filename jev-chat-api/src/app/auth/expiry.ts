/** setTimeout이 안전하게 다루는 최대 지연(2^31-1ms ≈ 24.8일). 초과하면 1ms로 처리되어 즉시 실행된다. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type ArmedExpiry = { ok: true; cancel: () => void } | { ok: false; reason: "invalid" | "expired" };

/**
 * principal.expiresAt(epoch ms)에 맞춰 onExpire를 호출하는 타이머를 건다.
 * - undefined: 만료 없음
 * - 숫자가 아니거나 유한하지 않음: invalid, 남은 시간 ≤ 0: expired (둘 다 타이머를 걸지 않는다)
 * - 남은 시간이 MAX_TIMER_MS 초과: 상한으로 끊어 재무장한다(바로 끊지 않는다)
 */
export function armExpiry(expiresAt: unknown, onExpire: () => void): ArmedExpiry {
  if (expiresAt === undefined) return { ok: true, cancel: () => {} };
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { ok: false, reason: "invalid" };
  if (expiresAt - Date.now() <= 0) return { ok: false, reason: "expired" };

  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;
  const arm = (): void => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return onExpire();
    timer = setTimeout(() => {
      timer = null;
      if (!cancelled) arm();
    }, Math.min(remaining, MAX_TIMER_MS));
    timer.unref();
  };
  arm();
  return {
    ok: true,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
