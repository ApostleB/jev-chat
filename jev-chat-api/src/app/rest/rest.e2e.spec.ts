import { randomUUID } from "node:crypto";
import { AdminConfigSchema, ApiErrorSchema, PageSchema, ReviewQueueItemSchema, SessionSummarySchema, TraceDetailSchema } from "@jev-chat/protocol";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import { StaticTokenAuthProvider } from "../auth/static-auth.provider";
import { createTestApp } from "../testing/test-app";

const enabled = !!process.env.TEST_DATABASE_URL;

describe.runIf(enabled)("REST E2E (통합)", () => {
  let url: string;
  let close: () => Promise<void>;
  let aliceSession = "";
  let traceId = "";

  const get = (path: string, token?: string) => fetch(`${url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (path: string, token: string, body?: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : null });

  beforeAll(async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.6)); // reference 경로 → 검수 큐 대상
    const auth = new StaticTokenAuthProvider({
      alice: { userId: "alice", roles: ["user"] },
      bob: { userId: "bob", roles: ["user", "debug"] },
      admin: { userId: "root", roles: ["user", "debug", "admin"] },
    });
    ({ url, close } = await createTestApp({ judge, auth }));
    // alice가 대화 1건 생성
    const c = io(`${url}/chat`, { auth: { token: "alice", protocolVersion: 1 }, transports: ["websocket"], reconnection: false, forceNew: true });
    await new Promise<void>((r) => c.once("connect", () => r()));
    const start = await c.timeout(3000).emitWithAck("session:start", {});
    aliceSession = start.data.sessionId;
    const done = new Promise<{ traceId: string }>((r) => c.once("chat:done", r));
    await c.timeout(3000).emitWithAck("chat:send", { sessionId: aliceSession, clientMsgId: randomUUID(), text: "법인카드 회식비 한도" });
    traceId = (await done).traceId;
    c.close();
  });
  afterAll(async () => close?.());

  it("토큰 없음 → 401 UNAUTHORIZED 본문", async () => {
    const r = await get("/api/sessions");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });

  it("세션 목록: user는 본인 것만, admin은 전체", async () => {
    const P = PageSchema(SessionSummarySchema);
    const mine = P.parse(await (await get("/api/sessions", "alice")).json());
    expect(mine.items.every((s) => s.userId === "alice")).toBe(true);
    expect(mine.items.some((s) => s.id === aliceSession)).toBe(true);
    const bobs = P.parse(await (await get("/api/sessions", "bob")).json());
    expect(bobs.items.some((s) => s.id === aliceSession)).toBe(false);
    const all = P.parse(await (await get("/api/sessions", "admin")).json());
    expect(all.items.some((s) => s.id === aliceSession)).toBe(true);
  });

  it("route 필터", async () => {
    const P = PageSchema(SessionSummarySchema);
    expect(P.parse(await (await get("/api/sessions?route=reference", "admin")).json()).items.length).toBeGreaterThan(0);
    expect(P.parse(await (await get("/api/sessions?route=faq", "admin")).json()).items.some((s) => s.id === aliceSession)).toBe(false);
  });

  it("턴 목록: 소유권 확인", async () => {
    expect((await get(`/api/sessions/${aliceSession}/turns`, "alice")).status).toBe(200);
    expect((await get(`/api/sessions/${aliceSession}/turns`, "bob")).status).toBe(403);
    expect((await get(`/api/sessions/${randomUUID()}/turns`, "alice")).status).toBe(404);
  });

  it("trace: debug + 세션 접근 권한 둘 다 필요", async () => {
    expect((await get(`/api/traces/${traceId}`, "alice")).status).toBe(403); // debug 아님
    expect((await get(`/api/traces/${traceId}`, "bob")).status).toBe(403); // debug지만 남의 세션
    const r = await get(`/api/traces/${traceId}`, "admin");
    expect(r.status).toBe(200);
    expect(TraceDetailSchema.parse(await r.json())).toMatchObject({ id: traceId, route: "reference" });
  });

  it("검수 큐와 검수 저장(admin, reviewer는 principal)", async () => {
    const q = PageSchema(ReviewQueueItemSchema).parse(await (await get("/api/reviews/queue", "admin")).json());
    expect(q.items.some((i) => i.traceId === traceId && !i.reviewed)).toBe(true);
    expect((await post(`/api/traces/${traceId}/review`, "alice", { verdict: "wrong" })).status).toBe(403);
    expect((await post(`/api/traces/${traceId}/review`, "admin", { note: "verdict 없음" })).status).toBe(400);
    expect((await post(`/api/traces/${traceId}/review`, "admin", { verdict: "partial", expectedChunkIds: ["card-002"], note: "회식비 조항" })).status).toBe(201);
    const detail = TraceDetailSchema.parse(await (await get(`/api/traces/${traceId}`, "admin")).json());
    expect(detail.reviews[0]).toMatchObject({ verdict: "partial", reviewerId: "root" });
  });

  it("[B9] 8KB 초과 body → 413 ApiError, 잘못된 커서 → 400, 없는 경로 → 404 ApiError", async () => {
    const big = await post(`/api/traces/${traceId}/review`, "admin", { verdict: "wrong", note: "가".repeat(3000) });
    expect(big.status).toBe(413);
    expect(ApiErrorSchema.parse(await big.json()).error.code).toBe("INVALID_INPUT");
    expect((await get("/api/sessions?cursor=not-a-cursor", "admin")).status).toBe(400);
    const missing = await get("/api/nope", "admin");
    expect(missing.status).toBe(404);
    expect(ApiErrorSchema.parse(await missing.json()).error.code).toBe("NOT_FOUND");
  });

  it("관리: config 조회, 지식 목록, 재로드", async () => {
    expect((await get("/api/admin/config", "alice")).status).toBe(403);
    const cfg = AdminConfigSchema.parse(await (await get("/api/admin/config", "admin")).json());
    expect(cfg).toMatchObject({ packName: "mini-test", model: "jev-1.13.0", templateVersion: "v1" });
    const chunks = (await (await get("/api/knowledge/chunks", "admin")).json()) as { items: { id: string }[] };
    expect(chunks.items.map((c: { id: string }) => c.id)).toContain("card-001");
    const reload = await post("/api/admin/knowledge/reload", "admin");
    expect(reload.status).toBe(201);
    expect(await reload.json()).toMatchObject({ changed: false });
  });

  it("[B9] 레이트 리밋 응답 본문은 retryAfterMs를 포함한다", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 7; i++) last = await post("/api/admin/knowledge/reload", "admin");
    expect(last?.status).toBe(429);
    const body = ApiErrorSchema.parse(await last!.json());
    expect(body.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
  });
});
