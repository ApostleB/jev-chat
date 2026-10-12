import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UiTurn } from "@/lib/turns";
import { ChatThread } from "./ChatThread";

const t = (o: Partial<UiTurn>): UiTurn => ({ localId: "l1", turnId: "t1", turnSeq: 1, clientMsgId: "c1", userText: "질문", status: "processing", ...o });

describe("ChatThread", () => {
  it("답변을 일반 텍스트로 렌더링한다(HTML 해석 안 함)", () => {
    render(<ChatThread turns={[t({ status: "completed", assistantText: "<b>굵게</b>\n둘째 줄", route: "faq", sources: [] })]} onRetry={() => {}} onSelect={() => {}} />);
    expect(screen.getByText(/<b>굵게<\/b>/)).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
  it("출처를 title · section으로 보여준다", () => {
    render(<ChatThread turns={[t({ status: "completed", assistantText: "a", route: "extractive", sources: [{ chunkId: "c", versionId: "v", contentHash: "h", title: "법인카드 규정", section: "제5조" }] })]} onRetry={() => {}} onSelect={() => {}} />);
    expect(screen.getByText("법인카드 규정 · 제5조")).toBeTruthy();
  });
  it("재시도 가능한 실패에는 다시 보내기 버튼", async () => {
    const onRetry = vi.fn();
    render(<ChatThread turns={[t({ status: "failed", error: { code: "QUEUE_TIMEOUT", retryable: true } })]} onRetry={onRetry} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "다시 보내기" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("[U2] 미확정 전송 오류는 안내 문구와 다시 보내기를 보여주고 진행 표시는 숨긴다", () => {
    render(
      <ChatThread
        turns={[t({ turnSeq: 0, stage: undefined, sendError: { code: "INTERNAL", message: "서버 응답을 확인하지 못했습니다.", retryable: true, uncertain: true } })]}
        onRetry={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/서버 응답을 확인하지 못했습니다/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 보내기" })).toBeTruthy();
    expect(screen.queryByText(/대기 중/)).toBeNull();
  });
  it("진행 단계 표시", () => {
    render(<ChatThread turns={[t({ stage: "judging" })]} onRetry={() => {}} onSelect={() => {}} />);
    expect(screen.getByText(/판단 중/)).toBeTruthy();
  });
});
