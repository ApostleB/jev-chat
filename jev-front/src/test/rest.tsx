import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

export type StubReply = { status: number; body: unknown };
export type StubHandler = (url: URL, init?: RequestInit) => StubReply | undefined;

/** pathname+search를 직접 보는 가짜 fetch를 전역에 건다. 호출 URL(path+search) 기록을 돌려준다. */
export function stubRest(handler: StubHandler) {
  const calls: { method: string; path: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? "GET", path: `${u.pathname}${u.search}` });
    const r = handler(u, init) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "없음" } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

export function renderWithQuery(ui: ReactElement): RenderResult {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
