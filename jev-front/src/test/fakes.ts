/** 실제 Response를 돌려주는 가짜 fetch. 호출 기록을 남긴다. */
export function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`;
    const r = routes[key] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "없음" } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

type Handler = (...args: unknown[]) => void;

/** 테스트가 끝날 때까지 결과를 쥐고 있는 Promise */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * socket.io-client Socket의 필요한 부분만 흉내 낸다. [U7]
 * - connect()는 연결 시도만 표시한다(이미 연결 중이면 아무것도 안 함). 서버 handshake 완료(`connect` 이벤트)는
 *   테스트가 `serverEmit("connect")`로 명시적으로 일으킨다.
 * - ackResponder는 값·Promise를 돌려주거나 throw해서 ack 지연·유실을 흉내 낸다.
 */
export class FakeSocket {
  connected = false;
  connectCalls = 0;
  readonly emitted: { event: string; payload: unknown }[] = [];
  private handlers = new Map<string, Set<Handler>>();
  ackResponder: (event: string, payload: unknown) => unknown = () => ({ ok: true, data: {} });

  on(event: string, h: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h);
    return this;
  }
  off(event: string, h?: Handler) {
    if (h) this.handlers.get(event)?.delete(h);
    else this.handlers.delete(event);
    return this;
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }
  /** 서버 → 클라이언트 이벤트 흉내 */
  serverEmit(event: string, ...args: unknown[]) {
    if (event === "connect") this.connected = true;
    if (event === "disconnect") this.connected = false;
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }
  connect() {
    this.connectCalls++;
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  timeout(_ms: number) {
    return {
      emitWithAck: async (event: string, payload: unknown) => {
        this.emitted.push({ event, payload });
        return await this.ackResponder(event, payload);
      },
    };
  }
}
