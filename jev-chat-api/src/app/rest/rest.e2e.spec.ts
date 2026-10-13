import { randomUUID } from "node:crypto";
import { AdminConfigSchema, ApiErrorSchema, PageSchema, ReviewQueueItemSchema, SessionSummarySchema, TraceDetailSchema, TurnPageSchema } from "@jev-chat/protocol";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import { StaticTokenAuthProvider } from "../auth/static-auth.provider";
import { createPrismaClient, dbConfigFromUrl } from "../../adapters/persistence/prisma";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
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

  it("[I-2] 턴 목록은 TurnPageSchema를 따르고 nextBeforeTurnSeq로 다음 페이지를 왕복한다", async () => {
    const prisma = createPrismaClient(dbConfigFromUrl(process.env.TEST_DATABASE_URL!));
    try {
      const repo = new TurnRepository(prisma);
      const { id } = await repo.createSession("alice", "front-test");
      for (let i = 1; i <= 55; i++) await repo.reserveTurn({ sessionId: id, clientMsgId: randomUUID(), userText: `질문 ${i}` });
      const first = TurnPageSchema.parse(await (await get(`/api/sessions/${id}/turns`, "alice")).json());
      expect(first.turns).toHaveLength(50);
      expect(first.turns[0]?.turnSeq).toBe(6);
      expect(first.turns.at(-1)?.turnSeq).toBe(55);
      expect(first).toMatchObject({ hasMore: true, nextBeforeTurnSeq: 6 });
      const second = TurnPageSchema.parse(await (await get(`/api/sessions/${id}/turns?beforeTurnSeq=${first.nextBeforeTurnSeq}`, "alice")).json());
      expect(second.turns.map((t) => t.turnSeq)).toEqual([1, 2, 3, 4, 5]);
      expect(second.hasMore).toBe(false);
      expect(second.nextBeforeTurnSeq).toBeUndefined();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("[Q1] 경로 파라미터의 UUID 대문자 표기도 같은 세션·trace로 해석한다", async () => {
    const turns = await get(`/api/sessions/${aliceSession.toUpperCase()}/turns`, "alice");
    expect(turns.status).toBe(200);
    expect(TurnPageSchema.parse(await turns.json()).turns.length).toBeGreaterThan(0);
    const trace = await get(`/api/traces/${traceId.toUpperCase()}`, "admin");
    expect(trace.status).toBe(200);
    expect(TraceDetailSchema.parse(await trace.json()).id).toBe(traceId);
    expect((await get("/api/sessions/NOT-A-UUID/turns", "alice")).status).toBe(404);
  });

  it("[M-9] DB의 route가 손상됐으면 캐스트하지 않고 500 INTERNAL ApiError", async () => {
    const prisma = createPrismaClient(dbConfigFromUrl(process.env.TEST_DATABASE_URL!));
    try {
      await prisma.messageTrace.update({ where: { id: traceId }, data: { route: "weird" } });
      const r = await get(`/api/traces/${traceId}`, "admin");
      expect(r.status).toBe(500);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("INTERNAL");
    } finally {
      await prisma.messageTrace.update({ where: { id: traceId }, data: { route: "reference" } });
      await prisma.$disconnect();
    }
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

  it("[B9] urlencoded 본문은 파싱하지 않는다 → 400 ApiError, 검수 미저장", async () => {
    const reviewCount = async () => TraceDetailSchema.parse(await (await get(`/api/traces/${traceId}`, "admin")).json()).reviews.length;
    const before = await reviewCount();
    const r = await fetch(`${url}/api/traces/${traceId}/review`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/x-www-form-urlencoded" },
      body: `verdict=wrong&pad=${"a".repeat(9000)}`,
    });
    expect(r.status).toBe(400);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("INVALID_INPUT");
    expect(await reviewCount()).toBe(before);
  });

  it("관리: config 조회, 지식 목록, 재로드", async () => {
    expect((await get("/api/admin/config", "alice")).status).toBe(403);
    const cfg = AdminConfigSchema.parse(await (await get("/api/admin/config", "admin")).json());
    expect(cfg).toMatchObject({ packName: "mini-test", model: "jev-1.13.0", templateVersion: "v2-en" });
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
