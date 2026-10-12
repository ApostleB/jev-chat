import { PageSchema, SessionSummarySchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import { fakeFetch } from "../test/fakes";
import { ApiClient, ApiRequestError } from "./api-client";

describe("ApiClient", () => {
  it("Bearer 토큰을 붙이고 스키마로 검증한다", async () => {
    const f = fakeFetch({ "GET /api/sessions": { status: 200, body: { items: [], nextCursor: null } } });
    const api = new ApiClient("http://api.test", () => "tok", f.fn);
    expect(await api.get("/api/sessions", PageSchema(SessionSummarySchema))).toEqual({ items: [], nextCursor: null });
    expect(new Headers(f.calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });
  it("ApiError 본문을 ApiRequestError로 바꾼다(retryAfterMs 포함)", async () => {
    const f = fakeFetch({ "POST /api/admin/knowledge/reload": { status: 429, body: { error: { code: "RATE_LIMITED", message: "잠시 후", retryAfterMs: 1200 } } } });
    const api = new ApiClient("http://api.test", () => "tok", f.fn);
    const err = await api.post("/api/admin/knowledge/reload", undefined, PageSchema(SessionSummarySchema)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterMs: 1200 });
  });
  it("토큰이 없으면 요청하지 않고 UNAUTHORIZED", async () => {
    const f = fakeFetch({});
    const api = new ApiClient("http://api.test", () => null, f.fn);
    await expect(api.get("/api/sessions", PageSchema(SessionSummarySchema))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.calls).toHaveLength(0);
  });
  it("스키마와 다른 응답은 INTERNAL", async () => {
    const f = fakeFetch({ "GET /api/sessions": { status: 200, body: { nope: 1 } } });
    const api = new ApiClient("http://api.test", () => "tok", f.fn);
    await expect(api.get("/api/sessions", PageSchema(SessionSummarySchema))).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("ApiClient — AbortSignal [F2]", () => {
  it("get의 signal을 fetch에 그대로 전달한다", async () => {
    const f = fakeFetch({ "GET /api/sessions": { status: 200, body: { items: [], nextCursor: null } } });
    const api = new ApiClient("http://api.test", () => "tok", f.fn);
    const ac = new AbortController();
    await api.get("/api/sessions", PageSchema(SessionSummarySchema), { signal: ac.signal });
    expect(f.calls[0]?.init?.signal).toBe(ac.signal);
  });
  it("지연된 fetch는 QueryClient.cancelQueries 시 abort된다", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    let seen: AbortSignal | undefined;
    const hang = ((_u: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const api = new ApiClient("http://api.test", () => "tok", hang);
    const qc = new QueryClient();
    const p = qc.fetchQuery({ queryKey: ["x"], queryFn: ({ signal }) => api.get("/api/sessions", PageSchema(SessionSummarySchema), { signal }) }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen?.aborted).toBe(false);
    await qc.cancelQueries();
    await p;
    expect(seen?.aborted).toBe(true);
  });
});
