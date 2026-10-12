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
