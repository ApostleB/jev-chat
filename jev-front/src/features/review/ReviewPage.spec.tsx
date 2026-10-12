import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery, stubRest, uuid } from "@/test/rest";
import { ReviewPage } from "./ReviewPage";

const item = (n: number, reviewed: boolean) => ({
  traceId: uuid(n), turnId: `t${n}`, sessionId: uuid(1), userText: `질문 ${n}`, assistantText: `답변 ${n}`, route: "faq", intent: "card", faqProb: 0.5, reviewed, createdAt: "2026-10-12T00:00:00Z",
});

beforeEach(() => sessionStorage.setItem("jev-chat.token", "t"));
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("ReviewPage", () => {
  it("대기 항목을 보여주고 reviewed 표시를 한다", async () => {
    stubRest((u) => (u.pathname === "/api/reviews/queue" ? { status: 200, body: { items: [item(2, false), item(3, true)], nextCursor: null } } : undefined));
    renderWithQuery(<ReviewPage enabled authEpoch={0} />);
    await screen.findByText("질문 2");
    expect(screen.getByText("검수 완료")).toBeTruthy();
  });

  it("검수 저장 시 POST 후 목록을 다시 불러온다", async () => {
    let reviewed = false;
    const { calls } = stubRest((u, init) => {
      if (u.pathname === "/api/reviews/queue") return { status: 200, body: { items: [item(2, reviewed)], nextCursor: null } };
      if (u.pathname === `/api/traces/${uuid(2)}/review` && init?.method === "POST") {
        reviewed = true;
        return { status: 201, body: { id: "r1", reviewerId: "a", createdAt: "2026-10-12T00:00:00Z", verdict: "correct" } };
      }
      return undefined;
    });
    renderWithQuery(<ReviewPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /질문 2/ }));
    await userEvent.click(screen.getByRole("radio", { name: "맞음" }));
    await userEvent.click(screen.getByRole("button", { name: "검수 저장" }));
    expect(await screen.findByText("검수 완료")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/reviews/queue")).toHaveLength(2);
  });

  it("저장이 403이면 서버 원문 대신 안전한 안내를 보여준다", async () => {
    stubRest((u, init) => {
      if (u.pathname === "/api/reviews/queue") return { status: 200, body: { items: [item(2, false)], nextCursor: null } };
      if (init?.method === "POST") return { status: 403, body: { error: { code: "FORBIDDEN", message: "내부 상세 <i>x</i>" } } };
      return undefined;
    });
    renderWithQuery(<ReviewPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /질문 2/ }));
    await userEvent.click(screen.getByRole("radio", { name: "틀림" }));
    await userEvent.click(screen.getByRole("button", { name: "검수 저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe("권한이 없습니다.");
  });
});
