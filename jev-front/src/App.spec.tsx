import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { FakeSocket } from "./test/fakes";

const sockets: FakeSocket[] = [];
const ioFactory = () => {
  const s = new FakeSocket();
  sockets.push(s);
  return s as never;
};

const config = (packName: string) => ({
  knowledgeVersionId: "00000000-0000-4000-8000-000000000009", packName, packVersion: "0.1.0", model: "jev-1.13.0", templateVersion: "v1-en", policy: {},
});

function stubFetch() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (new URL(url).pathname === "/api/admin/config") {
      if (auth === "Bearer admin-token") return new Response(JSON.stringify(config("관리자-전용-팩")), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "권한이 없습니다." } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "없음" } }), { status: 404, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App ioFactory={ioFactory} />
    </QueryClientProvider>,
  );

describe("App 셸", () => {
  beforeEach(() => {
    sockets.length = 0;
    stubFetch();
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("토큰이 없으면 설정 화면으로 시작하고, 저장하면 sessionStorage에만 둔다", async () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("설정");
    expect(screen.getByLabelText("접속 토큰")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("접속 토큰"), "my-token");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(sessionStorage.getItem("jev-chat.token")).toBe("my-token");
    expect(localStorage.length).toBe(0);
  });

  it("사이드바로 화면을 전환해도 채팅 연결(소켓)은 하나로 유지된다 [U9]", async () => {
    sessionStorage.setItem("jev-chat.token", "t");
    renderApp();
    for (const name of ["테스트 채팅", "대화 로그", "검수 대기", "지식 데이터", "설정", "테스트 채팅"]) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(name);
    }
    expect(sockets).toHaveLength(1);
  });

  it("[U6] 관리자 데이터 → 로그아웃 → 다른 토큰 로그인 시 이전 데이터가 보이지 않는다", async () => {
    sessionStorage.setItem("jev-chat.token", "admin-token");
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByText(/관리자-전용-팩/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(screen.queryByText(/관리자-전용-팩/)).toBeNull();
    expect(sockets[0]!.listenerCount()).toBe(0); // 이전 채팅 연결 정리
    await userEvent.type(screen.getByLabelText("접속 토큰"), "user-token");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("권한이 없습니다.")).toBeTruthy();
    expect(screen.queryByText(/관리자-전용-팩/)).toBeNull();
  });

  it("[P2] 로그아웃하면 토큰과 jev-chat.sessionId를 모두 지우고, 토큰은 화면에 다시 표시되지 않는다", async () => {
    sessionStorage.setItem("jev-chat.token", "admin-token");
    sessionStorage.setItem("jev-chat.sessionId", "00000000-0000-4000-8000-0000000000aa");
    const { container } = renderApp();
    await userEvent.click(screen.getByRole("button", { name: "설정" }));
    expect(container.innerHTML).not.toContain("admin-token");
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(sessionStorage.getItem("jev-chat.token")).toBeNull();
    expect(sessionStorage.getItem("jev-chat.sessionId")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("설정");
  });
});
