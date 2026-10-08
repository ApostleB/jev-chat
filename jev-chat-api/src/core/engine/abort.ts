/** signal이 abort되면 onAbort() 값으로 즉시 끝낸다. 원래 promise의 늦은 결과는 버린다. */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined); // 버려지는 원 Promise의 rejection을 관찰한다
    return Promise.resolve(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const listener = () => resolve(onAbort());
    signal.addEventListener("abort", listener, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", listener);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", listener);
        reject(e);
      },
    );
  });
}

/** 부모가 abort되면 함께 abort되는 자식. AbortSignal.any는 GC 친화적이라 수명이 긴 부모에서도 리스너가 쌓이지 않는다. */
export function linkedController(parent: AbortSignal): { signal: AbortSignal; abort: (reason?: unknown) => void } {
  const own = new AbortController();
  return { signal: AbortSignal.any([parent, own.signal]), abort: (reason?: unknown) => own.abort(reason) };
}
