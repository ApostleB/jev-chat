import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery, stubRest } from "@/test/rest";
import { SettingsPage } from "./SettingsPage";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("저장된 토큰 값은 다시 표시하지 않고 존재 여부만 보여준다", async () => {
    sessionStorage.setItem("jev-chat.token", "super-secret-token");
    stubRest(() => undefined);
    const { container } = renderWithQuery(<SettingsPage token="super-secret-token" authEpoch={0} onSave={vi.fn()} onLogout={vi.fn()} />);
    expect(screen.getByText("토큰이 저장되어 있습니다.")).toBeTruthy();
    expect(container.innerHTML).not.toContain("super-secret-token");
    expect((screen.getByLabelText("접속 토큰") as HTMLInputElement).value).toBe("");
  });

  it("설정 JSON(policy 포함)을 일반 텍스트로 표시", async () => {
    sessionStorage.setItem("jev-chat.token", "t");
    stubRest((u) =>
      u.pathname === "/api/admin/config"
        ? { status: 200, body: { knowledgeVersionId: "v1", packName: "<i>팩</i>", packVersion: "0.1.0", model: "jev", templateVersion: "v1", policy: { a: 1 } } }
        : undefined,
    );
    renderWithQuery(<SettingsPage token="t" authEpoch={0} onSave={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByText(/<i>팩<\/i>/)).toBeTruthy();
  });

  it("저장하면 입력칸을 비우고 onSave 호출", async () => {
    stubRest(() => undefined);
    const onSave = vi.fn();
    renderWithQuery(<SettingsPage token={null} authEpoch={0} onSave={onSave} onLogout={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("접속 토큰"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSave).toHaveBeenCalledWith("abc");
    expect((screen.getByLabelText("접속 토큰") as HTMLInputElement).value).toBe("");
  });
});
