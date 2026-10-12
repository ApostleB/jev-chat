import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlidingWindowRateLimiter } from "../chat/rate-limiter";
import { AdminController } from "./admin.controller";

describe("AdminController.reload", () => {
  afterEach(() => vi.restoreAllMocks());

  it("[M-3] 지식 재로드의 예상 밖 실패는 INTERNAL로 응답하되 원인(예외 이름)을 로그로 남기고 메시지는 남기지 않는다", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    class DbDown extends Error {
      override name = "DbDown";
    }
    const snapshots = { reload: async () => { throw new DbDown("password=secret host=10.0.0.1"); } };
    const ctrl = new AdminController(snapshots as never, {} as never, new SlidingWindowRateLimiter(30, 60_000));
    await expect(ctrl.reload({ userId: "root", roles: ["admin"] } as never)).rejects.toMatchObject({ response: { error: { code: "INTERNAL" } } });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain("DbDown");
    expect(logged).not.toContain("secret");
  });
});

describe("AdminController.config — templateVersion", () => {
  const limiter = () => new SlidingWindowRateLimiter(30, 60_000);
  const knowledge = { findVersion: async () => ({ packName: "p", packVersion: "1" }) };

  it("스냅샷이 있으면 실제 사용 중인 템플릿 라벨(스냅샷 값)을 내보낸다", async () => {
    const snapshots = { current: () => ({ knowledgeVersionId: "kv", templateVersion: "v1-ko", policy: {} }), templateVersionLabel: () => "v1-en" };
    const ctrl = new AdminController(snapshots as never, knowledge as never, limiter());
    expect((await ctrl.config()).templateVersion).toBe("v1-ko");
  });

  it("활성 지식이 없어도 서버 설정 언어의 라벨을 내보낸다(고정 v1 아님)", async () => {
    const snapshots = { current: () => { throw new Error("none"); }, templateVersionLabel: () => "v1-ko" };
    const ctrl = new AdminController(snapshots as never, knowledge as never, limiter());
    expect((await ctrl.config()).templateVersion).toBe("v1-ko");
  });
});
