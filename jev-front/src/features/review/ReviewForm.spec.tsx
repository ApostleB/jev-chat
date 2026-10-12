import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/fakes";
import { ReviewForm } from "./ReviewForm";

describe("ReviewForm", () => {
  it("입력값을 ReviewRequest로 만들어 제출(청크 ID 쉼표 분리, 빈 값 생략)", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<ReviewForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("radio", { name: "틀림" }));
    await userEvent.type(screen.getByLabelText("정답 FAQ ID"), "faq-card-dinner");
    await userEvent.type(screen.getByLabelText("정답 청크 ID"), "card-002, card-003");
    await userEvent.type(screen.getByLabelText("메모"), "회식비 조항");
    await userEvent.click(screen.getByRole("button", { name: "검수 저장" }));
    expect(onSubmit).toHaveBeenCalledWith({ verdict: "wrong", expectedFaqId: "faq-card-dinner", expectedChunkIds: ["card-002", "card-003"], note: "회식비 조항" });
  });
  it("판정 없이 제출할 수 없다", () => {
    render(<ReviewForm onSubmit={vi.fn(async () => {})} />);
    expect((screen.getByRole("button", { name: "검수 저장" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("저장 중에는 비활성화되어 중복 저장되지 않는다", async () => {
    const d = deferred<void>();
    const onSubmit = vi.fn(() => d.promise);
    render(<ReviewForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("radio", { name: "맞음" }));
    const btn = screen.getByRole("button", { name: "검수 저장" }) as HTMLButtonElement;
    await userEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    d.resolve();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
  });
  it("저장 실패(403 등)를 안전한 메시지로 보여주고 다시 시도할 수 있다", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("권한이 없습니다.");
    });
    render(<ReviewForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("radio", { name: "부분" }));
    await userEvent.click(screen.getByRole("button", { name: "검수 저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe("권한이 없습니다.");
    expect((screen.getByRole("button", { name: "검수 저장" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
