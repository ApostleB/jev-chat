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

const LINKED_PARENT = Symbol("linkedController.parent");

/**
 * 부모가 abort되면 함께 abort되는 자식. AbortSignal.any는 GC 친화적이라 수명이 긴 부모에서도 리스너가 쌓이지 않는다.
 * 다만 any()의 결과는 부모를 약하게만 참조하므로, 반환 객체가 부모를 강하게 쥐어 GC로 타임아웃이 사라지지 않게 한다(Codex T1).
 */
export function linkedController(parent: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  parent: AbortSignal;
} {
  const own = new AbortController();
  const signal = AbortSignal.any([parent, own.signal]);
  // 호출자가 signal만 보관하는 경우에도 부모가 살아 있도록 signal 자체가 부모를 강하게 참조한다.
  Object.defineProperty(signal, LINKED_PARENT, { value: parent });
  return { signal, abort: (reason?: unknown) => own.abort(reason), parent };
}
