import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/fakes";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("전송 중(ack 대기)에는 다시 제출하지 않는다", async () => {
    const d = deferred<void>();
    const onSend = vi.fn(() => d.promise);
    render(<Composer onSend={onSend} disabled={false} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "첫 질문{Enter}");
    await userEvent.type(box, "{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    d.resolve();
  });

  it("전송이 끝났을 때 보낸 텍스트 그대로면 비우고, 그 사이 편집한 초안은 보존", async () => {
    const d1 = deferred<void>();
    const onSend = vi.fn(() => d1.promise);
    render(<Composer onSend={onSend} disabled={false} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "첫 질문{Enter}");
    await userEvent.type(box, " 추가");
    d1.resolve();
    await vi.waitFor(() => expect(box.value).toBe("첫 질문 추가"));
  });

  it("전송 성공 후 편집이 없으면 입력창을 비운다", async () => {
    const onSend = vi.fn(async () => {});
    render(<Composer onSend={onSend} disabled={false} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "질문{Enter}");
    await vi.waitFor(() => expect(box.value).toBe(""));
  });

  it("전송 실패 메시지를 보여주고 초안은 유지", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("대화 세션이 준비되지 않았습니다.");
    });
    render(<Composer onSend={onSend} disabled={false} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "질문{Enter}");
    expect(await screen.findByText("대화 세션이 준비되지 않았습니다.")).toBeTruthy();
    expect(box.value).toBe("질문");
  });
});
