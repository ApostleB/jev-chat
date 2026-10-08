import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("GET /api/health → ok", async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    expect(moduleRef.get(HealthController).health()).toEqual({ status: "ok" });
  });
});
