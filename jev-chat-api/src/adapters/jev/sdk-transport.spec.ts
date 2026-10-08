import { describe, expect, it, vi } from "vitest";
import { JevTransportError } from "./transport";
import { retryAfterFrom, SdkJevTransport, toTransportError } from "./sdk-transport";
import { JevResponseError, type JevRequest } from "../../core";

const payload: JevRequest = {
  model: "jev-1.13.0",
  state: { employee_message: "법인카드 한도" },
  questions: { relevant: { type: "noul", instructions: "Q?", criteria: { true: "t", false: "f" } } },
};

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function transport(f: typeof fetch) {
  return new SdkJevTransport({ apiKey: "test-key", baseURL: "http://jev.test", fetch: f });
}

describe("SdkJevTransport", () => {
  it("성공 응답을 도메인 결과로 바꾼다", async () => {
    const f = fakeFetch(200, { model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 4 } });
    const r = await transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(r).toEqual({ model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { inputTokens: 120, outputTokens: 4 } });
    expect(f.calls[0]?.url).toBe("http://jev.test/v1/systemone");
    const sent = JSON.parse(String(f.calls[0]?.init?.body));
    expect(sent.model).toBe("jev-1.13.0");
    expect(f.calls).toHaveLength(1); // SDK 재시도 꺼짐
  });

  it("429 → rate_limited + retryAfterMs", async () => {
    const f = fakeFetch(429, { error: "rate" }, { "retry-after-ms": "250" });
    const err = await transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(JevTransportError);
    expect(err).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 250 });
    expect(f.calls).toHaveLength(1);
  });

  it("529 → overloaded, 500 → server, 400 → client", async () => {
    const s = new AbortController().signal;
    expect(await transport(fakeFetch(529, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("overloaded");
    expect(await transport(fakeFetch(500, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("server");
    expect(await transport(fakeFetch(400, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("client");
  });

  it("[P2] 503 + HTTP-date Retry-After → 남은 시간(ms)으로 해석", async () => {
    const future = new Date(Date.now() + 1500).toUTCString();
    const err = await transport(fakeFetch(503, {}, { "retry-after": future }).fn)
      .send(payload, { signal: new AbortController().signal, timeoutMs: 1000 })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "server", status: 503 });
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(1500);
  });

  it("[P2] retryAfterFrom: ms·초·날짜·잘못된 값·음수", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(retryAfterFrom(h({ "retry-after-ms": "250" }))).toBe(250);
    expect(retryAfterFrom(h({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterFrom(h({ "retry-after": new Date(10_000).toUTCString() }), () => 4_000)).toBe(6000);
    expect(retryAfterFrom(h({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterFrom(h({ "retry-after": "-1" }))).toBeUndefined();
    expect(retryAfterFrom(h({}))).toBeUndefined();
  });

  it("[P3] 401 → client(status 401), 재시도 대상 아님", async () => {
    const err = await transport(fakeFetch(401, { error: "bad key" }).fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toMatchObject({ kind: "client", status: 401 });
  });

  it("[P3] SDK가 아닌 예외는 매핑하지 않는다(toTransportError → null)", () => {
    expect(toTransportError(new TypeError("bug"), new AbortController().signal)).toBeNull();
  });

  it("이미 abort된 signal로 호출 → aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const hanging = ((_url: string, init?: RequestInit) =>
      init?.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : new Promise(() => {})) as unknown as typeof fetch;
    expect(await transport(hanging).send(payload, { signal: ctrl.signal, timeoutMs: 5000 }).catch((e) => e.kind)).toBe("aborted");
  });

  it("호출자 abort → aborted", async () => {
    const ctrl = new AbortController();
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const p = transport(hanging).send(payload, { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    expect(await p.catch((e) => e.kind)).toBe("aborted");
  });

  it("시도 타임아웃 → timeout", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const err = await transport(hanging).send(payload, { signal: new AbortController().signal, timeoutMs: 20 }).catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("[I2] 200 응답 형태 오류(usage 누락·비JSON·빈 본문) → JevResponseError, fetch 1회", async () => {
    const send = (f: ReturnType<typeof fakeFetch>) => transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
    const missing = fakeFetch(200, { model: "jev-1.13.0", answers: {} });
    expect(await send(missing)).toBeInstanceOf(JevResponseError);
    expect(missing.calls).toHaveLength(1);

    const calls: unknown[] = [];
    const html = (async (u: string) => (calls.push(u), new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    expect(await transport(html).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e)).toBeInstanceOf(JevResponseError);
    expect(calls).toHaveLength(1);

    const emptyCalls: unknown[] = [];
    const empty = (async (u: string) => (emptyCalls.push(u), new Response("", { status: 200 }))) as unknown as typeof fetch;
    expect(await transport(empty).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e)).toBeInstanceOf(JevResponseError);
    expect(emptyCalls).toHaveLength(1);
  });

  it("[6-2] usage 토큰이 음수·소수·비수치거나 model이 빈 문자열이면 JevResponseError", async () => {
    const base = { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    const bad: unknown[] = [
      { ...base, usage: { input_tokens: 1.5, output_tokens: 1 } },
      { ...base, usage: { input_tokens: 1, output_tokens: 0.2 } },
      { ...base, usage: { input_tokens: -1, output_tokens: 1 } },
      { ...base, usage: { input_tokens: 1, output_tokens: "3" } },
      { ...base, model: "" },
    ];
    for (const body of bad) {
      const f = fakeFetch(200, body);
      const err = await transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(JevResponseError);
      expect(f.calls).toHaveLength(1);
    }
    const zero = fakeFetch(200, { ...base, usage: { input_tokens: 0, output_tokens: 0 } });
    await expect(transport(zero.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 })).resolves.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("[6-5] SDK 호출에 시도 타임아웃(timeout)을 넘겨 SDK 기본값이 덮지 않게 한다", async () => {
    const f = fakeFetch(200, { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
    const t = transport(f.fn);
    const spy = vi.spyOn((t as unknown as { client: { systemOne: (...a: unknown[]) => unknown } }).client, "systemOne");
    await t.send(payload, { signal: new AbortController().signal, timeoutMs: 4321 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ timeout: 4321, retry: { maxRetries: 0 } });
  });
});
