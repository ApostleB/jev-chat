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
  describe("[S2] 이미 다시 보낸 실패 턴", () => {
    const failed = t({ status: "failed", error: { code: "RESTARTED", retryable: true } });
    it("retryOfTurnSeq가 이 턴의 turnSeq인 턴이 있으면 버튼을 숨기고 '다시 보냄'을 표시한다", () => {
      const retry = t({ clientMsgId: "c2", localId: "l2", turnSeq: 2, retryOfTurnSeq: 1, status: "completed", assistantText: "a", route: "faq", sources: [] });
      render(<ChatThread turns={[failed, retry]} onRetry={() => {}} onSelect={() => {}} />);
      expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
      expect(screen.getByText("다시 보냄")).toBeTruthy();
    });
    it("재전송 턴이 진행 중이어도 숨긴다", () => {
      const retry = t({ clientMsgId: "c2", localId: "l2", turnSeq: 0, retryOfTurnSeq: 1, status: "processing", stage: "queued" });
      render(<ChatThread turns={[failed, retry]} onRetry={() => {}} onSelect={() => {}} />);
      expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
    });
    it("재전송이 확정 거절된 경우(sendError, uncertain=false)에는 원본 버튼을 유지한다", () => {
      const retry = t({ clientMsgId: "c2", localId: "l2", turnSeq: 0, retryOfTurnSeq: 1, sendError: { code: "QUEUE_FULL", message: "많음", retryable: true, uncertain: false } });
      render(<ChatThread turns={[failed, retry]} onRetry={() => {}} onSelect={() => {}} />);
      expect(screen.getAllByRole("button", { name: "다시 보내기" })).toHaveLength(2);
    });
    it("미확정 복구 재전송 표시는 다른 턴에 영향이 없다", () => {
      const other = t({ clientMsgId: "c3", localId: "l3", turnSeq: 5, status: "failed", error: { code: "RESTARTED", retryable: true } });
      render(<ChatThread turns={[failed, other]} onRetry={() => {}} onSelect={() => {}} />);
      expect(screen.getAllByRole("button", { name: "다시 보내기" })).toHaveLength(2);
    });
  });
});
