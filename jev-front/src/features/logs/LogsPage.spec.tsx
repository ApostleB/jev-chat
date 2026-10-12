import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery, stubRest, uuid } from "@/test/rest";
import { LogsPage } from "./LogsPage";

const SID = uuid(1);
const session = (id: string, createdAt: string, lastActiveAt: string, userId = "u1", turnCount = 2) => ({ id, userId, channel: "web", createdAt, lastActiveAt, turnCount });
const turn = (seq: number, extra: Record<string, unknown> = {}) => ({
  turnId: `t${seq}`, turnSeq: seq, clientMsgId: uuid(100 + seq), userText: `질문 ${seq}`, status: "completed", assistantText: `답변 ${seq}`, route: "faq", traceId: uuid(200 + seq), ...extra,
});
const traceBody = {
  id: uuid(203), turnId: "t3", sessionId: SID, route: "faq", createdAt: "2026-10-12T00:00:00Z",
  data: { route: "faq", bStatus: "skipped", intentProbs: { card: 0.9 }, candidates: [] },
  reviews: [{ id: "r1", reviewerId: "admin1", createdAt: "2026-10-12T01:00:00Z", verdict: "wrong", note: "<b>메모</b> 원문" }],
};

beforeEach(() => sessionStorage.setItem("jev-chat.token", "t"));
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("LogsPage", () => {
  it("토큰이 없으면 안내만 보이고 요청하지 않는다", () => {
    sessionStorage.clear();
    const { calls } = stubRest(() => undefined);
    renderWithQuery(<LogsPage enabled={false} authEpoch={0} />);
    expect(screen.getByText("토큰을 먼저 입력하세요.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("[P5] 세션 목록은 서버가 준 순서 그대로 표시하고(마지막 활동 기준 재정렬 없음), 더 보기로 이어 붙인다", async () => {
    const { calls } = stubRest((u) => {
      if (u.pathname !== "/api/sessions") return undefined;
      if (u.searchParams.get("cursor") === "c1") return { status: 200, body: { items: [session(uuid(3), "2026-10-10T00:00:00Z", "2026-10-12T09:00:00Z", "userC")], nextCursor: null } };
      return {
        status: 200,
        body: { items: [session(uuid(1), "2026-10-12T00:00:00Z", "2026-10-12T00:01:00Z", "userA"), session(uuid(2), "2026-10-11T00:00:00Z", "2026-10-12T08:00:00Z", "userB")], nextCursor: "c1" },
      };
    });
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await screen.findByText("userA");
    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByText("userC");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => ["userA", "userB", "userC"].find((u) => r.textContent?.includes(u)))).toEqual(["userA", "userB", "userC"]);
    expect(calls.map((c) => c.path)).toEqual(["/api/sessions", "/api/sessions?cursor=c1"]);
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  it("route 필터를 서버 쿼리로 전달한다", async () => {
    const { calls } = stubRest((u) => (u.pathname === "/api/sessions" ? { status: 200, body: { items: [], nextCursor: null } } : undefined));
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await screen.findByText("세션이 없습니다.");
    await userEvent.click(screen.getByRole("combobox", { name: "route 필터" }));
    await userEvent.click(await screen.findByRole("option", { name: "blocked" }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/sessions?route=blocked")).toBe(true));
  });

  it("intent 필터를 route와 함께 서버 쿼리로 전달하고, '전체'로 되돌리면 파라미터를 뺀다", async () => {
    const { calls } = stubRest((u) => (u.pathname === "/api/sessions" ? { status: 200, body: { items: [], nextCursor: null } } : undefined));
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await screen.findByText("세션이 없습니다.");
    await userEvent.click(screen.getByRole("combobox", { name: "route 필터" }));
    await userEvent.click(await screen.findByRole("option", { name: "faq" }));
    await userEvent.click(screen.getByRole("combobox", { name: "intent 필터" }));
    await userEvent.click(await screen.findByRole("option", { name: "how_to" }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/sessions?route=faq&intent=how_to")).toBe(true));
    await userEvent.click(screen.getByRole("combobox", { name: "intent 필터" }));
    await userEvent.click(await screen.findByRole("option", { name: "전체 intent" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.path === "/api/sessions?route=faq").length).toBeGreaterThan(0));
  });

  it("[P1] 턴 목록은 TurnPage로 검증하고, hasMore면 '이전 턴 더 보기'로 beforeTurnSeq 요청 후 앞에 붙인다", async () => {
    const { calls } = stubRest((u) => {
      if (u.pathname === "/api/sessions") return { status: 200, body: { items: [session(SID, "2026-10-12T00:00:00Z", "2026-10-12T00:01:00Z")], nextCursor: null } };
      if (u.pathname === `/api/sessions/${SID}/turns`) {
        if (u.searchParams.get("beforeTurnSeq") === "3") return { status: 200, body: { turns: [turn(1), turn(2)], hasMore: false } };
        return { status: 200, body: { turns: [turn(3), turn(4)], hasMore: true, nextBeforeTurnSeq: 3 } };
      }
      return undefined;
    });
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /u1/ }));
    await screen.findByText("질문 3");
    await userEvent.click(screen.getByRole("button", { name: "이전 턴 더 보기" }));
    await screen.findByText("질문 1");
    const texts = screen.getAllByText(/^질문 \d$/).map((e) => e.textContent);
    expect(texts).toEqual(["질문 1", "질문 2", "질문 3", "질문 4"]);
    expect(calls.map((c) => c.path)).toContain(`/api/sessions/${SID}/turns?beforeTurnSeq=3`);
    expect(screen.queryByRole("button", { name: "이전 턴 더 보기" })).toBeNull();
  });

  it("[P1] 계약을 어긴 턴 응답(hasMore인데 nextBeforeTurnSeq 없음)은 목록 대신 오류로 처리", async () => {
    stubRest((u) => {
      if (u.pathname === "/api/sessions") return { status: 200, body: { items: [session(SID, "2026-10-12T00:00:00Z", "2026-10-12T00:01:00Z")], nextCursor: null } };
      if (u.pathname === `/api/sessions/${SID}/turns`) return { status: 200, body: { turns: [turn(3)], hasMore: true } };
      return undefined;
    });
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /u1/ }));
    expect(await screen.findByText("서버 응답 형식이 올바르지 않습니다.")).toBeTruthy();
    expect(screen.queryByText("질문 3")).toBeNull();
  });

  it("[P3] 읽기 전용: 전송 입력창이 없고, 턴을 누르면 trace 서랍에서 판단과 검수 이력을 텍스트로 보여준다", async () => {
    stubRest((u) => {
      if (u.pathname === "/api/sessions") return { status: 200, body: { items: [session(SID, "2026-10-12T00:00:00Z", "2026-10-12T00:01:00Z")], nextCursor: null } };
      if (u.pathname === `/api/sessions/${SID}/turns`) return { status: 200, body: { turns: [turn(3, { userText: "<script>x</script>" })], hasMore: false } };
      if (u.pathname === `/api/traces/${uuid(203)}`) return { status: 200, body: traceBody };
      return undefined;
    });
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /u1/ }));
    expect(await screen.findByText("<script>x</script>")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "trace 보기 (턴 3)" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("<b>메모</b> 원문")).toBeTruthy(); // 태그가 해석되지 않고 문자 그대로
    expect(within(dialog).getByText(/card/)).toBeTruthy(); // JudgmentPanel
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });

  it("trace 조회가 403이면 서랍에 권한 안내를 보여준다", async () => {
    stubRest((u) => {
      if (u.pathname === "/api/sessions") return { status: 200, body: { items: [session(SID, "2026-10-12T00:00:00Z", "2026-10-12T00:01:00Z")], nextCursor: null } };
      if (u.pathname === `/api/sessions/${SID}/turns`) return { status: 200, body: { turns: [turn(3)], hasMore: false } };
      if (u.pathname === `/api/traces/${uuid(203)}`) return { status: 403, body: { error: { code: "FORBIDDEN", message: "권한이 없습니다." } } };
      return undefined;
    });
    renderWithQuery(<LogsPage enabled authEpoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /u1/ }));
    await userEvent.click(await screen.findByRole("button", { name: "trace 보기 (턴 3)" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("권한이 없습니다.")).toBeTruthy();
  });
});
