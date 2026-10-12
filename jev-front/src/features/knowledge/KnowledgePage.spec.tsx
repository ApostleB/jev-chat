import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { renderWithQuery, stubRest } from "@/test/rest";
import { KnowledgePage } from "./KnowledgePage";

const faq = { id: "faq-1", intent: "card", summary: "카드 요약", answer: "카드 답변", sourceChunkId: "card-001", variants: ["법인카드 쓰는 법"] };
const chunk = { id: "card-001", module: "card", kind: "rule", title: "카드 규정", section: "제1조", text: "<b>본문</b>" };

beforeEach(() => sessionStorage.setItem("jev-chat.token", "t"));
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("KnowledgePage", () => {
  it("FAQ 탭과 청크 탭을 읽기 전용으로 보여준다(텍스트 그대로)", async () => {
    stubRest((u) => {
      if (u.pathname === "/api/knowledge/faqs") return { status: 200, body: { items: [faq], nextCursor: null } };
      if (u.pathname === "/api/knowledge/chunks") return { status: 200, body: { items: [chunk], nextCursor: null } };
      return undefined;
    });
    renderWithQuery(<><KnowledgePage enabled authEpoch={0} /><Toaster /></>);
    expect(await screen.findByText("카드 요약")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "청크" }));
    expect(await screen.findByText("<b>본문</b>")).toBeTruthy();
  });

  it("재로드: changed 여부를 알리고, 429면 retryAfterMs 안내를 보여준다", async () => {
    let n = 0;
    stubRest((u, init) => {
      if (u.pathname === "/api/knowledge/faqs") return { status: 200, body: { items: [], nextCursor: null } };
      if (u.pathname === "/api/admin/knowledge/reload" && init?.method === "POST") {
        n++;
        return n === 1
          ? { status: 201, body: { versionId: "v1", changed: false } }
          : { status: 429, body: { error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 4000 } } };
      }
      return undefined;
    });
    renderWithQuery(<><KnowledgePage enabled authEpoch={0} /><Toaster /></>);
    const btn = await screen.findByRole("button", { name: "활성 지식 인덱스 다시 로드" });
    await userEvent.click(btn);
    expect(await screen.findByText("변경 사항이 없습니다.")).toBeTruthy();
    await userEvent.click(btn);
    expect(await screen.findByText("요청이 많습니다. 4초 후 다시 시도하세요.")).toBeTruthy();
  });
});

describe("KnowledgePage — 인증 세대 [F2]", () => {
  it("로그아웃(세대 변경) 뒤 늦게 끝난 재로드의 toast는 뜨지 않는다", async () => {
    const { markAuthChanged } = await import("@/lib/auth-generation");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/admin/knowledge/reload" && init?.method === "POST") {
        await gate;
        return new Response(JSON.stringify({ versionId: "v1", changed: true }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    renderWithQuery(<><KnowledgePage enabled authEpoch={0} /><Toaster /></>);
    await userEvent.click(await screen.findByRole("button", { name: "활성 지식 인덱스 다시 로드" }));
    markAuthChanged();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("새 버전을 적용했습니다.")).toBeNull();
  });
});
