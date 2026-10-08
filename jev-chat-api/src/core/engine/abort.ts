/** signal이 abort되면 onAbort() 값으로 즉시 끝낸다. 원래 promise의 늦은 결과는 버린다. */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort());
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

/** 부모가 abort되면 함께 abort되는 자식 컨트롤러 */
export function linkedController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener("abort", () => child.abort(parent.reason), { once: true });
  return child;
}
