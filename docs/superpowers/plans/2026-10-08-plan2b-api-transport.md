# 계획 2B: API 전송 계층 (인증 · 수락 큐 · Gateway · REST · 운영) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 계획 2A의 기반 위에 실제로 대화할 수 있는 서버를 완성한다 — 인증·권한, 세션별 수락 임계 구역과 큐, ChatEngine 실행과 저장을 묶는 ChatService, Socket.IO `/chat` Gateway, jev-front용 REST, 보관 기간 정리, PM2 배포 설정.

**Architecture:** `src/app/`에 Nest 계층을 둔다. 순수 로직(수락 큐, 레이트 리밋, 인증 판정, 행 → 프로토콜 매핑)은 Nest 없이 단위 테스트 가능한 클래스로 만들고, Gateway·Controller는 얇게 유지한다. ChatService는 저장소 인터페이스(`TurnStore`)와 이벤트 인터페이스(`ChatEvents`)에만 의존해 transport를 바꿔도 재사용된다. 통합·E2E는 `TEST_DATABASE_URL` + 가짜 Judge로 실행한다(실제 Jev 키 불필요).

**Tech Stack:** NestJS 12.1.2 (`@nestjs/websockets`, `@nestjs/platform-socket.io`), socket.io 4.8.3 / socket.io-client 4.8.3, zod ^4.6, Vitest ^5 + unplugin-swc

**설계 문서:** `docs/superpowers/specs/2026-10-08-jev-chat-design.md` v3 — 1장(수락·처리·종료 상태 매핑), 4장(소켓 프로토콜·REST·권한), 6장(테스트 계층), 0장 결정 9(PM2).
**선행:** 계획 1 + 체크포인트 1 수정, 계획 2A 완료.

## Global Constraints

- 계획 1·2A의 Global Constraints를 모두 따른다(한국어, 커밋 trailer, core 수정 금지, `.env*` 읽기 금지, push 금지, 버전 고정).
- `socket.io`와 `socket.io-client`는 **4.8.3으로 고정**한다(`@nestjs/platform-socket.io@12.1.2`가 socket.io를 4.8.3으로 고정 의존하므로 타입 불일치를 피한다).
- 모든 수신 페이로드는 `packages/protocol`의 zod 스키마로 검증하고, `isWithinPayloadLimit`(8KB)를 먼저 적용한다.
- 권한: 모든 소켓 이벤트·REST 요청에서 principal을 확인하고, 세션 접근은 `session.userId === principal.userId` 또는 `admin`. `chat:trace`는 debug 권한 소켓에만 개별 발송(broadcast 금지).
- 오류 응답에 스택·내부 메시지·키·SQL을 넣지 않는다. 클라이언트에는 프로토콜 `ErrorCode`와 한국어 안내 문장만.
- 레이트 리밋(사용자 ID 기준, 재연결 무관): 메시지 분당 10건, 세션 생성 분당 20건, 관리 API 분당 30건, 지식 재로드 분당 6회.
- 세션당 대기+처리 최대 5건, 큐 대기 상한은 실행 스냅샷 `policy.deadlines.queueMs`(기본 10000), 엔진 기한 `engineMs`(8000), 저장 기한 `saveMs`(3000).
- 이벤트는 저장 결과를 확인한 **뒤에만** 보낸다(저장 실패를 성공으로 알리지 않음).

## 파일 구조

```
jev-chat/
├─ ecosystem.config.js                     PM2 (시크릿 없음)
├─ packages/protocol/src/rest.ts           REST DTO zod 스키마 (front 공유)
└─ jev-chat-api/src/app/
   ├─ auth/
   │  ├─ auth.types.ts                     AuthProvider 포트, AuthedPrincipal, AUTH_PROVIDER
   │  ├─ dev-auth.provider.ts              DevAuthProvider (상수시간 비교)
   │  ├─ static-auth.provider.ts           StaticTokenAuthProvider (테스트·다중 principal)
   │  ├─ access.ts                         canAccessSession, hasRole
   │  └─ http-auth.guard.ts                REST Bearer 인증 + @Roles 가드
   ├─ chat/
   │  ├─ rate-limiter.ts                   SlidingWindowRateLimiter
   │  ├─ session-queue.ts                  세션별 임계 구역 + 슬롯 + 순차 실행
   │  ├─ turn-mapper.ts                    TurnRow → protocol Turn / ChatDone / ChatError
   │  ├─ chat-events.ts                    ChatEvents 포트
   │  ├─ turn-store.ts                     TurnStore 포트 (TurnRepository가 구현)
   │  ├─ chat.service.ts                   수락·처리·종료 오케스트레이션
   │  ├─ io.adapter.ts                     CORS를 env로 설정하는 IoAdapter
   │  └─ chat.gateway.ts                   /chat 네임스페이스
   ├─ rest/
   │  ├─ api-error.ts                      ErrorCode → HTTP 매핑 예외 필터
   │  ├─ sessions.controller.ts
   │  ├─ traces.controller.ts              trace 조회·검수 큐·검수 저장
   │  └─ admin.controller.ts               config, knowledge 목록·재로드
   ├─ ops/retention.service.ts             보관 기간 지난 턴 삭제
   └─ chat.module.ts / rest.module.ts
   (adapters/persistence/review.repository.ts, session/knowledge 저장소 확장)
```

---

### Task 1: 인증·권한 + 레이트 리밋 + 세션 큐 (순수 로직)

**Files:**
- Create: `jev-chat-api/src/app/auth/{auth.types.ts,dev-auth.provider.ts,static-auth.provider.ts,access.ts}`
- Create: `jev-chat-api/src/app/chat/{rate-limiter.ts,session-queue.ts}`
- Test: `jev-chat-api/src/app/auth/auth.spec.ts`, `jev-chat-api/src/app/chat/rate-limiter.spec.ts`, `jev-chat-api/src/app/chat/session-queue.spec.ts`

**Interfaces:**
- Consumes (core): `Principal`, `Role`
- Produces:
  - `interface AuthedPrincipal extends Principal { expiresAt?: number }`
  - `interface AuthProvider { verify(token: string): Promise<AuthedPrincipal | null> }`, `AUTH_PROVIDER = Symbol("AUTH_PROVIDER")`
  - `class DevAuthProvider implements AuthProvider` — `constructor(expectedToken: string)`, 성공 시 `{ userId: "dev-admin", roles: ["user", "debug", "admin"] }`
  - `class StaticTokenAuthProvider implements AuthProvider` — `constructor(tokens: Record<string, AuthedPrincipal>)`
  - `hasRole(p: Principal, role: Role): boolean`, `canAccessSession(p: Principal, sessionUserId: string): boolean`
  - `class SlidingWindowRateLimiter` — `constructor(limit: number, windowMs: number, now?: () => number)`, `take(key: string): { ok: true } | { ok: false; retryAfterMs: number }`
  - `class SessionQueue` — `constructor(opts: { capacity: number })`, `withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>`, `tryReserve(sessionId: string): boolean`, `release(sessionId: string): void`, `run(sessionId: string, task: () => Promise<void>): void`(세션별 순차 실행), `size(sessionId: string): number`

- [ ] **Step 1: 실패 테스트 작성**

`jev-chat-api/src/app/auth/auth.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DevAuthProvider } from "./dev-auth.provider";
import { StaticTokenAuthProvider } from "./static-auth.provider";
import { canAccessSession, hasRole } from "./access";

const TOKEN = "d".repeat(32);

describe("DevAuthProvider", () => {
  const p = new DevAuthProvider(TOKEN);
  it("일치하는 토큰은 공유 테스트 관리자 계정", async () => {
    expect(await p.verify(TOKEN)).toEqual({ userId: "dev-admin", roles: ["user", "debug", "admin"] });
  });
  it("불일치·길이 다름·빈 토큰은 null", async () => {
    expect(await p.verify("x".repeat(32))).toBeNull();
    expect(await p.verify(TOKEN + "x")).toBeNull();
    expect(await p.verify("")).toBeNull();
  });
  it("32자 미만 기대 토큰으로는 생성할 수 없다", () => {
    expect(() => new DevAuthProvider("short")).toThrow();
  });
});

describe("StaticTokenAuthProvider", () => {
  it("토큰별 principal", async () => {
    const p = new StaticTokenAuthProvider({ a: { userId: "alice", roles: ["user"] }, b: { userId: "bob", roles: ["user", "debug"] } });
    expect(await p.verify("a")).toEqual({ userId: "alice", roles: ["user"] });
    expect(await p.verify("zzz")).toBeNull();
  });
});

describe("access", () => {
  const alice = { userId: "alice", roles: ["user" as const] };
  const admin = { userId: "root", roles: ["user" as const, "admin" as const] };
  it("본인 세션만, admin은 전체", () => {
    expect(canAccessSession(alice, "alice")).toBe(true);
    expect(canAccessSession(alice, "bob")).toBe(false);
    expect(canAccessSession(admin, "bob")).toBe(true);
  });
  it("hasRole", () => {
    expect(hasRole(alice, "debug")).toBe(false);
    expect(hasRole(admin, "admin")).toBe(true);
  });
});
```

`jev-chat-api/src/app/chat/rate-limiter.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rate-limiter";

describe("SlidingWindowRateLimiter", () => {
  it("창 안에서 limit개까지 허용, 초과 시 retryAfterMs", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(2, 60_000, () => t);
    expect(r.take("u").ok).toBe(true);
    t = 10_000;
    expect(r.take("u").ok).toBe(true);
    t = 20_000;
    expect(r.take("u")).toEqual({ ok: false, retryAfterMs: 40_000 });
  });
  it("키별로 독립", () => {
    const r = new SlidingWindowRateLimiter(1, 1000, () => 0);
    expect(r.take("a").ok).toBe(true);
    expect(r.take("b").ok).toBe(true);
    expect(r.take("a").ok).toBe(false);
  });
  it("창이 지나면 다시 허용", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(1, 1000, () => t);
    r.take("u");
    t = 1000;
    expect(r.take("u").ok).toBe(true);
  });
  it("거절된 시도는 기록하지 않는다", () => {
    let t = 0;
    const r = new SlidingWindowRateLimiter(1, 1000, () => t);
    r.take("u");
    t = 500;
    r.take("u");
    t = 1000;
    expect(r.take("u").ok).toBe(true);
  });
});
```

`jev-chat-api/src/app/chat/session-queue.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SessionQueue } from "./session-queue";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SessionQueue", () => {
  it("withLock은 같은 세션의 임계 구역을 직렬화한다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    await Promise.all([
      q.withLock("s", async () => {
        log.push("a-start");
        await new Promise((r) => setTimeout(r, 10));
        log.push("a-end");
      }),
      q.withLock("s", async () => {
        log.push("b-start");
        log.push("b-end");
      }),
    ]);
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("withLock 안에서 예외가 나도 잠금이 풀린다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    await expect(q.withLock("s", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await q.withLock("s", async () => 1)).toBe(1);
  });

  it("슬롯은 capacity까지만 예약된다", () => {
    const q = new SessionQueue({ capacity: 2 });
    expect([q.tryReserve("s"), q.tryReserve("s"), q.tryReserve("s")]).toEqual([true, true, false]);
    q.release("s");
    expect(q.tryReserve("s")).toBe(true);
    expect(q.tryReserve("other")).toBe(true);
  });

  it("run은 세션별로 순차 실행하고 다른 세션은 병렬", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    let releaseFirst!: () => void;
    q.run("s", () => new Promise<void>((r) => { log.push("s1"); releaseFirst = r; }));
    q.run("s", async () => { log.push("s2"); });
    q.run("t", async () => { log.push("t1"); });
    await tick();
    expect(log).toEqual(["s1", "t1"]);
    releaseFirst();
    await tick();
    await tick();
    expect(log).toEqual(["s1", "t1", "s2"]);
  });

  it("run 작업이 실패해도 다음 작업이 실행된다", async () => {
    const q = new SessionQueue({ capacity: 5 });
    const log: string[] = [];
    q.run("s", async () => { throw new Error("boom"); });
    q.run("s", async () => { log.push("next"); });
    await tick();
    await tick();
    expect(log).toEqual(["next"]);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- auth rate-limiter session-queue`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`jev-chat-api/src/app/auth/auth.types.ts`:
```ts
import type { Principal } from "../../core";

export interface AuthedPrincipal extends Principal {
  /** epoch ms. 지나면 서버가 연결을 끊는다 */
  expiresAt?: number;
}

export interface AuthProvider {
  verify(token: string): Promise<AuthedPrincipal | null>;
}

export const AUTH_PROVIDER = Symbol("AUTH_PROVIDER");
```

`jev-chat-api/src/app/auth/dev-auth.provider.ts`:
```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthedPrincipal, AuthProvider } from "./auth.types";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** MVP 공유 테스트 관리자 계정. production에서는 env 검증 단계에서 시작이 거부된다. */
export class DevAuthProvider implements AuthProvider {
  private readonly expected: Buffer;

  constructor(expectedToken: string) {
    if (expectedToken.length < 32) throw new Error("DEV_ACCESS_TOKEN은 32자 이상이어야 합니다.");
    this.expected = digest(expectedToken);
  }

  async verify(token: string): Promise<AuthedPrincipal | null> {
    if (!token) return null;
    // 길이에 무관한 상수 시간 비교를 위해 해시끼리 비교한다
    return timingSafeEqual(digest(token), this.expected) ? { userId: "dev-admin", roles: ["user", "debug", "admin"] } : null;
  }
}
```

`jev-chat-api/src/app/auth/static-auth.provider.ts`:
```ts
import type { AuthedPrincipal, AuthProvider } from "./auth.types";

/** 테스트용: 토큰 → principal 고정 매핑 */
export class StaticTokenAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Record<string, AuthedPrincipal>) {}
  async verify(token: string): Promise<AuthedPrincipal | null> {
    return Object.hasOwn(this.tokens, token) ? this.tokens[token]! : null;
  }
}
```

`jev-chat-api/src/app/auth/access.ts`:
```ts
import type { Principal, Role } from "../../core";

export const hasRole = (p: Principal, role: Role): boolean => p.roles.includes(role);
export const canAccessSession = (p: Principal, sessionUserId: string): boolean => p.userId === sessionUserId || hasRole(p, "admin");
```

`jev-chat-api/src/app/chat/rate-limiter.ts`:
```ts
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = () => Date.now()) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]!) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true };
  }
}
```

`jev-chat-api/src/app/chat/session-queue.ts`:
```ts
/**
 * 세션 단위 동시성 제어 (단일 프로세스, PM2 fork instances:1 전제).
 * - withLock: 수락 임계 구역(멱등 조회 → 슬롯 예약 → DB 예약 → enqueue)을 직렬화
 * - tryReserve/release: 대기+처리 슬롯(capacity)
 * - run: 세션별 순차 실행
 */
export class SessionQueue {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly slots = new Map<string, number>();

  constructor(private readonly opts: { capacity: number }) {}

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }

  tryReserve(sessionId: string): boolean {
    const n = this.slots.get(sessionId) ?? 0;
    if (n >= this.opts.capacity) return false;
    this.slots.set(sessionId, n + 1);
    return true;
  }

  release(sessionId: string): void {
    const n = (this.slots.get(sessionId) ?? 0) - 1;
    if (n <= 0) this.slots.delete(sessionId);
    else this.slots.set(sessionId, n);
  }

  size(sessionId: string): number {
    return this.slots.get(sessionId) ?? 0;
  }

  run(sessionId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task).catch(() => undefined);
    this.chains.set(sessionId, next);
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
  }
}
```

- [ ] **Step 4: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test -- auth rate-limiter session-queue && pnpm --filter jev-chat-api typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add jev-chat-api/src/app/auth jev-chat-api/src/app/chat
git commit -m "feat(api): 인증 포트(Dev/Static), 접근 규칙, 레이트 리밋, 세션 큐

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: REST DTO(protocol) + TurnRow → 프로토콜 매핑 + TurnStore/ChatEvents 포트

**Files:**
- Create: `packages/protocol/src/rest.ts`, Modify: `packages/protocol/src/index.ts`
- Create: `jev-chat-api/src/app/chat/{turn-mapper.ts,chat-events.ts,turn-store.ts}`
- Test: `packages/protocol/src/rest.spec.ts`, `jev-chat-api/src/app/chat/turn-mapper.spec.ts`

**Interfaces:**
- Consumes: `TurnRow`(2A), protocol `TurnSchema`, `ChatDoneEventSchema`, `ChatErrorEventSchema`, `ErrorCode`, `SourceRef`, `Route`
- Produces (protocol rest.ts): `PageSchema(item)`, `SessionSummarySchema`, `ReviewRequestSchema`, `TraceDetailSchema`, `ReviewQueueItemSchema`, `AdminConfigSchema`, `KnowledgeChunkItemSchema`, `KnowledgeFaqItemSchema`, `ReloadResponseSchema`, `ApiErrorSchema` 및 각 `z.infer` 타입
- Produces (app):
  - `toProtocolTurn(row: TurnRow): Turn`
  - `toDoneEvent(row: TurnRow, sessionId: string): ChatDoneEvent` (completed만)
  - `toErrorEvent(row: TurnRow, sessionId: string, message: string): ChatErrorEvent` (failed만)
  - `ERROR_MESSAGES: Record<ErrorCode, string>`
  - `interface ChatEvents { status(e: ChatStatusEvent): void; done(e: ChatDoneEvent): void; error(e: ChatErrorEvent): void; trace(sessionId: string, e: ChatTraceEvent): void }`
  - `type TurnStore = Pick<TurnRepository, "findSession" | "createSession" | "findTurnByClientMsgId" | "reserveTurn" | "completeTurn" | "failTurn" | "listTurns" | "loadCompletedTurns">`

- [ ] **Step 1: 실패 테스트 작성**

`packages/protocol/src/rest.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ApiErrorSchema, PageSchema, ReviewRequestSchema, SessionSummarySchema } from "./index";

describe("REST DTO", () => {
  it("Page는 items와 nextCursor(없으면 null)", () => {
    const P = PageSchema(SessionSummarySchema);
    expect(P.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });
  it("검수 요청: verdict 필수, 메모 2000자 이하", () => {
    expect(ReviewRequestSchema.safeParse({ verdict: "wrong", expectedFaqId: "faq-a", note: "정답은 faq-a" }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ note: "x" }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ verdict: "correct", note: "가".repeat(2001) }).success).toBe(false);
  });
  it("API 오류 본문", () => {
    expect(ApiErrorSchema.parse({ error: { code: "FORBIDDEN", message: "권한이 없습니다." } }).error.code).toBe("FORBIDDEN");
  });
});
```

`jev-chat-api/src/app/chat/turn-mapper.spec.ts`:
```ts
import { ChatDoneEventSchema, ChatErrorEventSchema, TurnSchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import { toDoneEvent, toErrorEvent, toProtocolTurn } from "./turn-mapper";

const sid = "00000000-0000-4000-8000-000000000001";
const base: TurnRow = {
  id: "t1", sessionId: sid, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a1", userText: "q",
  status: "processing", errorCode: null, errorRetryable: null, assistantText: null, route: null, sources: null, traceId: null, createdAt: new Date(),
};
const src = [{ chunkId: "c1", versionId: "v1", contentHash: "h", title: "법인카드 규정", section: "한도" }];

describe("turn-mapper (프로토콜 스키마를 실제로 통과해야 한다)", () => {
  it("processing 턴", () => {
    expect(TurnSchema.parse(toProtocolTurn(base))).toMatchObject({ status: "processing" });
  });
  it("정상 completed 턴과 done 이벤트", () => {
    const row: TurnRow = { ...base, status: "completed", assistantText: "답", route: "faq", sources: src, traceId: "tr1" };
    expect(TurnSchema.parse(toProtocolTurn(row))).toMatchObject({ route: "faq", traceId: "tr1" });
    const done = ChatDoneEventSchema.parse(toDoneEvent(row, sid));
    expect(done).toMatchObject({ turnId: "t1", turnSeq: 1, route: "faq", traceId: "tr1" });
    expect(done.error).toBeUndefined();
  });
  it("route=error로 completed된 턴은 error를 포함", () => {
    const row: TurnRow = { ...base, status: "completed", assistantText: "일시적 문제", route: "error", sources: [], traceId: "tr2", errorCode: "JEV_UNAVAILABLE", errorRetryable: true };
    expect(TurnSchema.parse(toProtocolTurn(row)).error).toEqual({ code: "JEV_UNAVAILABLE", retryable: true });
    expect(ChatDoneEventSchema.parse(toDoneEvent(row, sid)).error).toEqual({ code: "JEV_UNAVAILABLE", retryable: true });
  });
  it("failed 턴과 error 이벤트", () => {
    const row: TurnRow = { ...base, status: "failed", errorCode: "RESTARTED", errorRetryable: true };
    expect(TurnSchema.parse(toProtocolTurn(row)).error).toEqual({ code: "RESTARTED", retryable: true });
    expect(ChatErrorEventSchema.parse(toErrorEvent(row, sid, "다시 시도해주세요."))).toMatchObject({ code: "RESTARTED", retryable: true });
  });
  it("알 수 없는 errorCode는 INTERNAL로 정규화", () => {
    const row: TurnRow = { ...base, status: "failed", errorCode: "WEIRD", errorRetryable: false };
    expect(toProtocolTurn(row).error).toEqual({ code: "INTERNAL", retryable: false });
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `pnpm --filter @jev-chat/protocol test && pnpm --filter jev-chat-api test -- turn-mapper`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`packages/protocol/src/rest.ts`:
```ts
import { z } from "zod";
import { ErrorCodeSchema, RouteSchema } from "./common";

export function PageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const ApiErrorSchema = z.object({ error: z.object({ code: ErrorCodeSchema, message: z.string() }) });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  turnCount: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const VerdictSchema = z.enum(["correct", "wrong", "partial"]);

export const ReviewRequestSchema = z.object({
  verdict: VerdictSchema,
  expectedIntent: z.string().max(30).optional(),
  expectedFaqId: z.string().max(100).optional(),
  expectedChunkIds: z.array(z.string().max(100)).max(20).optional(),
  note: z.string().max(2000).optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewSchema = ReviewRequestSchema.extend({ id: z.string(), reviewerId: z.string(), createdAt: z.string() });
export type Review = z.infer<typeof ReviewSchema>;

export const TraceDetailSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  route: RouteSchema,
  createdAt: z.string(),
  /** core TraceRecord(JSON) 원본 */
  data: z.record(z.string(), z.unknown()),
  reviews: z.array(ReviewSchema),
});
export type TraceDetail = z.infer<typeof TraceDetailSchema>;

export const ReviewQueueItemSchema = z.object({
  traceId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  userText: z.string(),
  assistantText: z.string().nullable(),
  route: RouteSchema,
  intent: z.string().nullable(),
  faqProb: z.number().nullable(),
  reviewed: z.boolean(),
  createdAt: z.string(),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const AdminConfigSchema = z.object({
  knowledgeVersionId: z.string().nullable(),
  packName: z.string().nullable(),
  packVersion: z.string().nullable(),
  model: z.string(),
  templateVersion: z.string(),
  policy: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export const KnowledgeChunkItemSchema = z.object({ id: z.string(), module: z.string(), kind: z.string(), title: z.string(), section: z.string(), text: z.string() });
export const KnowledgeFaqItemSchema = z.object({ id: z.string(), intent: z.string(), summary: z.string(), answer: z.string(), sourceChunkId: z.string().nullable(), variants: z.array(z.string()) });
export type KnowledgeChunkItem = z.infer<typeof KnowledgeChunkItemSchema>;
export type KnowledgeFaqItem = z.infer<typeof KnowledgeFaqItemSchema>;

export const ReloadResponseSchema = z.object({ versionId: z.string(), changed: z.boolean() });
export type ReloadResponse = z.infer<typeof ReloadResponseSchema>;
```
`packages/protocol/src/index.ts`에 `export * from "./rest";` 추가 후 `pnpm --filter @jev-chat/protocol build`.

`jev-chat-api/src/app/chat/turn-mapper.ts`:
```ts
import { ErrorCodeSchema, type ChatDoneEvent, type ChatErrorEvent, type ErrorCode, type Route, type Turn } from "@jev-chat/protocol";
import type { TurnRow } from "../../adapters/persistence/turn.repository";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "인증이 필요합니다.",
  FORBIDDEN: "권한이 없습니다.",
  PROTOCOL_UNSUPPORTED: "지원하지 않는 프로토콜 버전입니다. 화면을 새로고침하세요.",
  INVALID_INPUT: "요청 형식이 올바르지 않습니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
  QUEUE_FULL: "처리 대기 중인 질문이 많습니다. 잠시 후 다시 시도해주세요.",
  QUEUE_TIMEOUT: "처리 대기 시간이 초과되었습니다. 다시 시도해주세요.",
  JEV_UNAVAILABLE: "일시적인 문제로 답변을 만들지 못했습니다. 잠시 후 다시 시도해주세요.",
  RESTARTED: "서버가 재시작되어 처리하지 못했습니다. 다시 시도해주세요.",
  NOT_FOUND: "대상을 찾을 수 없습니다.",
  INTERNAL: "처리 중 오류가 발생했습니다. 다시 시도해주세요.",
};

function normalizeCode(code: string | null): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "INTERNAL";
}

function errorOf(row: TurnRow): { code: ErrorCode; retryable: boolean } {
  return { code: normalizeCode(row.errorCode), retryable: row.errorRetryable ?? false };
}

export function toProtocolTurn(row: TurnRow): Turn {
  const base = { turnId: row.id, turnSeq: row.turnSeq, clientMsgId: row.clientMsgId, userText: row.userText, status: row.status };
  if (row.status === "processing") return base;
  if (row.status === "failed") return { ...base, error: errorOf(row), ...(row.traceId ? { traceId: row.traceId } : {}) };
  return {
    ...base,
    assistantText: row.assistantText ?? "",
    route: row.route as Route,
    sources: row.sources ?? [],
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(row.route === "error" ? { error: errorOf(row) } : {}),
  };
}

export function toDoneEvent(row: TurnRow, sessionId: string): ChatDoneEvent {
  return {
    sessionId,
    clientMsgId: row.clientMsgId,
    turnSeq: row.turnSeq,
    turnId: row.id,
    text: row.assistantText ?? "",
    route: row.route as Route,
    sources: row.sources ?? [],
    traceId: row.traceId ?? "",
    ...(row.route === "error" ? { error: errorOf(row) } : {}),
  };
}

export function toErrorEvent(row: TurnRow, sessionId: string, message?: string): ChatErrorEvent {
  const { code, retryable } = errorOf(row);
  return { sessionId, clientMsgId: row.clientMsgId, turnSeq: row.turnSeq, code, retryable, message: message ?? ERROR_MESSAGES[code] };
}
```

`jev-chat-api/src/app/chat/chat-events.ts`:
```ts
import type { ChatDoneEvent, ChatErrorEvent, ChatStatusEvent, ChatTraceEvent } from "@jev-chat/protocol";

/** ChatService가 결과를 알리는 포트. Gateway가 room 단위로 구현한다(다른 transport로 교체 가능). */
export interface ChatEvents {
  status(e: ChatStatusEvent): void;
  done(e: ChatDoneEvent): void;
  error(e: ChatErrorEvent): void;
  /** debug 권한 소켓에만 보낸다 */
  trace(sessionId: string, e: ChatTraceEvent): void;
}
```

`jev-chat-api/src/app/chat/turn-store.ts`:
```ts
import type { TurnRepository } from "../../adapters/persistence/turn.repository";

export type TurnStore = Pick<
  TurnRepository,
  "findSession" | "createSession" | "findTurnByClientMsgId" | "reserveTurn" | "completeTurn" | "failTurn" | "listTurns" | "loadCompletedTurns"
>;
export const TURN_STORE = Symbol("TURN_STORE");
```

- [ ] **Step 4: 실행 → 통과 확인**

Run: `pnpm --filter @jev-chat/protocol test && pnpm --filter @jev-chat/protocol build && pnpm --filter jev-chat-api test -- turn-mapper && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/protocol jev-chat-api/src/app/chat
git commit -m "feat: REST DTO 스키마, 턴→프로토콜 매핑, TurnStore·ChatEvents 포트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ChatService (수락 임계 구역 · 처리 · 종료 상태 · 멱등 재발송)

**Files:**
- Create: `jev-chat-api/src/app/chat/chat.service.ts`, `jev-chat-api/src/app/chat/in-memory-turn-store.ts`(테스트 전용)
- Test: `jev-chat-api/src/app/chat/chat.service.spec.ts`

**Interfaces:**
- Consumes: `TurnStore`, `ChatEvents`, `SessionQueue`, `SlidingWindowRateLimiter`, `SnapshotService`, `NoActiveKnowledgeError`, core `ChatEngine`, `Judge`, `ExtractiveAnswerer`, `EngineResult`, `AuthedPrincipal`, `canAccessSession`, `hasRole`, mapper 함수들
- Produces:
  - `class ChatService` — `constructor(deps: { store: TurnStore; snapshots: Pick<SnapshotService, "current">; judge: Judge; queue: SessionQueue; sendLimiter: SlidingWindowRateLimiter; sessionLimiter: SlidingWindowRateLimiter; now?: () => number })`
  - `startSession(p: AuthedPrincipal, req: SessionStartRequest, channel: string): Promise<Ack<SessionStartResponse>>`
  - `send(p: AuthedPrincipal, req: ChatSendRequest, events: ChatEvents): Promise<Ack<ChatSendResponse>>`
  - `inflightCount(): number`

동작 계약(설계 1장):
- `send`: 세션 없음 → `NOT_FOUND`, 소유권 없음 → `FORBIDDEN`, 레이트 리밋 → `RATE_LIMITED(retryAfterMs)`. `withLock(sessionId)` 안에서 ① 멱등 조회(같은 text → `duplicate` ack 후 결과 재발송, 다른 text → `INVALID_INPUT`; processing인데 진행 목록에 없으면 즉시 `failed(RESTARTED)` 후 재발송) ② `tryReserve` 실패 → `QUEUE_FULL(retryAfterMs: 2000)`, DB 기록 없음 ③ `reserveTurn` 실패 → 슬롯 반환, `INTERNAL` ④ enqueue. 그 다음 `accepted` ack.
- 처리: 큐 대기 > `queueMs` → `failTurn(QUEUE_TIMEOUT, true)` → `chat:error`. 활성 지식 없음 → `failTurn(INTERNAL, false)`. 엔진 예외 → `failTurn(INTERNAL, false)`. 정상 → `completeTurn(saveMs)` 결과 확인 후 `chat:done`(+debug면 `chat:trace`). 저장 실패 → `failTurn(INTERNAL, false)` 시도 후 `chat:error`. 모든 경로에서 슬롯 반환·진행 목록 제거.
- 재발송은 이벤트(`chat:done`/`chat:error`)로 하며, ack는 항상 즉시 반환한다.

- [ ] **Step 1: 테스트용 인메모리 저장소 작성**

`jev-chat-api/src/app/chat/in-memory-turn-store.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { CompletedTurn, EngineResult, TraceRecord } from "../../core";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import type { TurnStore } from "./turn-store";

/** 단위 테스트 전용 TurnStore. 실제 동작은 TurnRepository 통합 테스트로 검증한다. */
export class InMemoryTurnStore implements TurnStore {
  readonly sessions = new Map<string, { id: string; userId: string; next: number }>();
  readonly turns: TurnRow[] = [];
  readonly traces = new Map<string, TraceRecord>();
  failComplete = false;

  async createSession(userId: string, _channel: string) {
    const id = randomUUID();
    this.sessions.set(id, { id, userId, next: 1 });
    return { id };
  }
  async findSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { id: s.id, userId: s.userId } : null;
  }
  async findTurnByClientMsgId(sessionId: string, clientMsgId: string) {
    return this.turns.find((t) => t.sessionId === sessionId && t.clientMsgId === clientMsgId) ?? null;
  }
  async reserveTurn(input: { sessionId: string; clientMsgId: string; userText: string; retryOfTurnSeq?: number }) {
    const s = this.sessions.get(input.sessionId)!;
    const row: TurnRow = {
      id: randomUUID(), sessionId: input.sessionId, turnSeq: s.next++, clientMsgId: input.clientMsgId, userText: input.userText,
      status: "processing", errorCode: null, errorRetryable: null, assistantText: null, route: null, sources: null, traceId: null, createdAt: new Date(),
    };
    this.turns.push(row);
    return row;
  }
  async completeTurn(turnId: string, result: EngineResult) {
    if (this.failComplete) throw new Error("db down");
    const t = this.turns.find((x) => x.id === turnId);
    if (!t || t.status !== "processing") return null;
    const traceId = randomUUID();
    Object.assign(t, {
      status: "completed", assistantText: result.text, route: result.route, sources: result.sources, traceId,
      errorCode: result.route === "error" ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
      errorRetryable: result.route === "error" ? true : null,
    });
    this.traces.set(traceId, result.trace);
    return { traceId };
  }
  async failTurn(turnId: string, code: string, retryable: boolean) {
    const t = this.turns.find((x) => x.id === turnId);
    if (!t || t.status !== "processing") return false;
    Object.assign(t, { status: "failed", errorCode: code, errorRetryable: retryable });
    return true;
  }
  async listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }) {
    const all = this.turns.filter((t) => t.sessionId === sessionId && (!opts.beforeTurnSeq || t.turnSeq < opts.beforeTurnSeq)).sort((a, b) => a.turnSeq - b.turnSeq);
    return { turns: all.slice(-opts.limit), hasMore: all.length > opts.limit };
  }
  async loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]> {
    return this.turns
      .filter((t) => t.sessionId === sessionId && t.status === "completed" && t.turnSeq < beforeTurnSeq)
      .sort((a, b) => a.turnSeq - b.turnSeq)
      .slice(-limit)
      .map((t) => ({ turnSeq: t.turnSeq, userText: t.userText, assistantText: t.assistantText ?? "", sources: (t.sources ?? []).map((s) => ({ title: s.title, section: s.section })) }));
  }
}
```
(`build:exclude` — `tsconfig.build.json`의 `exclude`에 `"src/app/chat/in-memory-turn-store.ts"` 추가)

- [ ] **Step 2: 실패 테스트 작성**

`jev-chat-api/src/app/chat/chat.service.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { ChatDoneEvent, ChatErrorEvent, ChatStatusEvent, ChatTraceEvent } from "@jev-chat/protocol";
import { ChatDoneEventSchema, ChatErrorEventSchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Judge } from "../../core";
import { chunkFixture, faqFixture } from "../../core/testing/fixtures";
import { FakeJudge, makeSnapshot, okRelevance, okTurn } from "../../core/testing/fakes";
import { ChatService } from "./chat.service";
import type { ChatEvents } from "./chat-events";
import { InMemoryTurnStore } from "./in-memory-turn-store";
import { SessionQueue } from "./session-queue";
import { SlidingWindowRateLimiter } from "./rate-limiter";

const chunks = [chunkFixture({ id: "card-1", title: "법인카드 규정", section: "한도", text: "법인카드 1회 사용 한도는 50만 원이다" })];
const faqs = [faqFixture({ id: "faq-card", summary: "법인카드 1회 한도", variants: ["법인카드 한도 얼마예요"], answer: "1회 50만 원입니다.", sourceChunkId: "card-1" })];
const alice = { userId: "alice", roles: ["user" as const] };
const bob = { userId: "bob", roles: ["user" as const] };
const debugAlice = { userId: "alice", roles: ["user" as const, "debug" as const] };

class Recorder implements ChatEvents {
  statuses: ChatStatusEvent[] = [];
  dones: ChatDoneEvent[] = [];
  errors: ChatErrorEvent[] = [];
  traces: ChatTraceEvent[] = [];
  status(e: ChatStatusEvent) { this.statuses.push(e); }
  done(e: ChatDoneEvent) { this.dones.push(ChatDoneEventSchema.parse(e)); }
  error(e: ChatErrorEvent) { this.errors.push(ChatErrorEventSchema.parse(e)); }
  trace(_s: string, e: ChatTraceEvent) { this.traces.push(e); }
}

const faqJudge = () =>
  new FakeJudge(
    async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.95, none: 0.05 } } }),
    async (req) => okRelevance(req.chunk.id, 0.1),
  );

function setup(opts: { judge?: Judge; capacity?: number; sendLimit?: number; policy?: typeof DEFAULT_POLICY; now?: () => number } = {}) {
  const store = new InMemoryTurnStore();
  const snap = makeSnapshot({ chunks, faqs, ...(opts.policy ? { policy: opts.policy } : {}) });
  const svc = new ChatService({
    store,
    snapshots: { current: () => snap },
    judge: opts.judge ?? faqJudge(),
    queue: new SessionQueue({ capacity: opts.capacity ?? 5 }),
    sendLimiter: new SlidingWindowRateLimiter(opts.sendLimit ?? 10, 60_000),
    sessionLimiter: new SlidingWindowRateLimiter(20, 60_000),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { store, svc };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function session(svc: ChatService, p = alice) {
  const r = await svc.startSession(p, {}, "front-test");
  if (!r.ok) throw new Error("session");
  return r.data.sessionId;
}

describe("ChatService", () => {
  it("정상 흐름: accepted ack → status → done(저장 후)", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const ev = new Recorder();
    const ack = await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요" }, ev);
    expect(ack).toMatchObject({ ok: true, data: { status: "accepted", turnSeq: 1 } });
    await settle();
    expect(ev.dones).toHaveLength(1);
    expect(ev.dones[0]).toMatchObject({ route: "faq", turnSeq: 1 });
    expect(ev.statuses.map((s) => s.stage)).toEqual(["queued", "judging", "answering"]);
    expect(store.turns[0]?.status).toBe("completed");
    expect(ev.traces).toHaveLength(0); // debug 아님
  });

  it("debug 권한이면 trace도 보낸다", async () => {
    const { svc } = setup();
    const sid = await session(svc, debugAlice);
    const ev = new Recorder();
    await svc.send(debugAlice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요" }, ev);
    await settle();
    expect(ev.traces).toHaveLength(1);
    expect(ev.traces[0]?.trace).toMatchObject({ route: "faq" });
  });

  it("다른 사용자의 세션 → FORBIDDEN, 없는 세션 → NOT_FOUND", async () => {
    const { svc } = setup();
    const sid = await session(svc, alice);
    expect(await svc.send(bob, { sessionId: sid, clientMsgId: randomUUID(), text: "q" }, new Recorder())).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await svc.send(alice, { sessionId: randomUUID(), clientMsgId: randomUUID(), text: "q" }, new Recorder())).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("멱등: 같은 clientMsgId+text → duplicate, 완료 결과를 이벤트로 재발송", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "법인카드 한도 얼마예요" }, new Recorder());
    await settle();
    const ev = new Recorder();
    expect(await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "법인카드 한도 얼마예요" }, ev)).toMatchObject({ ok: true, data: { status: "duplicate", turnSeq: 1 } });
    await settle();
    expect(ev.dones).toHaveLength(1);
    expect(store.turns).toHaveLength(1);
  });

  it("멱등: 같은 clientMsgId + 다른 text → INVALID_INPUT", async () => {
    const { svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "a" }, new Recorder());
    expect(await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "b" }, new Recorder())).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("stale processing(진행 목록에 없음) 재전송 → 즉시 failed(RESTARTED) 후 chat:error", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await store.reserveTurn({ sessionId: sid, clientMsgId: id, userText: "q" }); // 서버 재시작 전 남은 턴 흉내
    const ev = new Recorder();
    expect(await svc.send(alice, { sessionId: sid, clientMsgId: id, text: "q" }, ev)).toMatchObject({ ok: true, data: { status: "duplicate" } });
    await settle();
    expect(ev.errors[0]).toMatchObject({ code: "RESTARTED", retryable: true });
  });

  it("세션 대기+처리 5건 초과 → QUEUE_FULL, DB 기록 없음", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const { store, svc } = setup({ judge, capacity: 2 });
    const sid = await session(svc);
    const send = () => svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드" }, new Recorder());
    expect((await send()).ok).toBe(true);
    expect((await send()).ok).toBe(true);
    expect(await send()).toMatchObject({ ok: false, error: { code: "QUEUE_FULL", retryAfterMs: 2000 } });
    expect(store.turns).toHaveLength(2);
    release();
    await settle();
    expect((await send()).ok).toBe(true); // 슬롯 반환 후 다시 가능
  });

  it("레이트 리밋 → RATE_LIMITED + retryAfterMs", async () => {
    const { svc } = setup({ sendLimit: 1 });
    const sid = await session(svc);
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "a" }, new Recorder());
    const r = await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "b" }, new Recorder());
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!r.ok) expect(r.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("세션 내 순차 처리: 두 번째 턴은 첫 턴 완료 후 그 문맥을 본다", async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.9));
    const { svc } = setup({ judge });
    const sid = await session(svc);
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드 한도" }, new Recorder());
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "그럼 회식비는요?" }, new Recorder());
    await settle();
    expect(judge.turnCalls[1]?.recentTurns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("큐 대기가 queueMs를 넘으면 failed(QUEUE_TIMEOUT)", async () => {
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const { svc } = setup({ judge, now: () => t });
    const sid = await session(svc);
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드" }, new Recorder());
    const ev = new Recorder();
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드 둘째" }, ev);
    t = DEFAULT_POLICY.deadlines.queueMs + 1;
    release();
    await settle();
    expect(ev.errors[0]).toMatchObject({ code: "QUEUE_TIMEOUT", retryable: true });
  });

  it("엔진 예외 → failed(INTERNAL) + chat:error, 큐는 계속 동작", async () => {
    const judge: Judge = { judgeTurn: async () => { throw new Error("bug"); }, judgeRelevance: async () => { throw new Error("bug"); } };
    const { store, svc } = setup({ judge });
    const sid = await session(svc);
    const ev = new Recorder();
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드" }, ev);
    await settle();
    expect(ev.errors[0]).toMatchObject({ code: "INTERNAL", retryable: false });
    expect(store.turns[0]?.status).toBe("failed");
    expect(svc.inflightCount()).toBe(0);
  });

  it("저장 실패 → done을 보내지 않고 chat:error(INTERNAL)", async () => {
    const { store, svc } = setup();
    store.failComplete = true;
    const sid = await session(svc);
    const ev = new Recorder();
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요" }, ev);
    await settle();
    expect(ev.dones).toHaveLength(0);
    expect(ev.errors[0]).toMatchObject({ code: "INTERNAL" });
  });

  it("Jev 장애(route=error)는 completed + done(error 포함)", async () => {
    const judge = new FakeJudge(
      async () => ({ ok: false, errorKind: "provider", message: "529", audit: { call: "turn", status: "failed", attempts: 2, latencyMs: 1 } }),
      async (req) => okRelevance(req.chunk.id, 0),
    );
    const { svc } = setup({ judge });
    const sid = await session(svc);
    const ev = new Recorder();
    await svc.send(alice, { sessionId: sid, clientMsgId: randomUUID(), text: "법인카드" }, ev);
    await settle();
    expect(ev.dones[0]).toMatchObject({ route: "error", error: { code: "JEV_UNAVAILABLE", retryable: true } });
  });

  it("startSession: 새 세션 생성, 기존 세션은 최신 50턴 + hasMore/nextBeforeTurnSeq", async () => {
    const { store, svc } = setup();
    const created = await svc.startSession(alice, {}, "front-test");
    expect(created).toMatchObject({ ok: true, data: { turns: [], hasMore: false } });
    const sid = created.ok ? created.data.sessionId : "";
    for (let i = 0; i < 52; i++) await store.reserveTurn({ sessionId: sid, clientMsgId: randomUUID(), userText: `q${i}` });
    const r = await svc.startSession(alice, { sessionId: sid }, "front-test");
    expect(r.ok && r.data.turns.length).toBe(50);
    expect(r.ok && r.data.hasMore).toBe(true);
    expect(r.ok && r.data.nextBeforeTurnSeq).toBe(3);
    expect(await svc.startSession(bob, { sessionId: sid }, "front-test")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
```

- [ ] **Step 3: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- chat.service`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`jev-chat-api/src/app/chat/chat.service.ts`:
```ts
import { randomUUID } from "node:crypto";
import type {
  Ack,
  ChatSendRequest,
  ChatSendResponse,
  ErrorCode,
  SessionStartRequest,
  SessionStartResponse,
} from "@jev-chat/protocol";
import { ChatEngine, ExtractiveAnswerer, type EngineResult, type Judge } from "../../core";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import type { AuthedPrincipal } from "../auth/auth.types";
import { canAccessSession, hasRole } from "../auth/access";
import type { SnapshotService } from "../knowledge/snapshot.service";
import type { ChatEvents } from "./chat-events";
import type { SlidingWindowRateLimiter } from "./rate-limiter";
import type { SessionQueue } from "./session-queue";
import { ERROR_MESSAGES, toDoneEvent, toErrorEvent, toProtocolTurn } from "./turn-mapper";
import type { TurnStore } from "./turn-store";

const HISTORY_LIMIT = 50;
const QUEUE_FULL_RETRY_MS = 2000;

interface Deps {
  store: TurnStore;
  snapshots: Pick<SnapshotService, "current">;
  judge: Judge;
  queue: SessionQueue;
  sendLimiter: SlidingWindowRateLimiter;
  sessionLimiter: SlidingWindowRateLimiter;
  now?: () => number;
}

function fail<T>(code: ErrorCode, retryAfterMs?: number): Ack<T> {
  const retryable = code === "RATE_LIMITED" || code === "QUEUE_FULL" || code === "INTERNAL";
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
}

export class ChatService {
  private readonly inflight = new Set<string>();
  private readonly engine: ChatEngine;
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? (() => Date.now());
    this.engine = new ChatEngine({ judge: deps.judge, answerer: new ExtractiveAnswerer(), contextReader: deps.store });
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  async startSession(p: AuthedPrincipal, req: SessionStartRequest, channel: string): Promise<Ack<SessionStartResponse>> {
    let sessionId = req.sessionId;
    if (!sessionId) {
      const limited = this.deps.sessionLimiter.take(p.userId);
      if (!limited.ok) return fail("RATE_LIMITED", limited.retryAfterMs);
      sessionId = (await this.deps.store.createSession(p.userId, channel)).id;
    } else {
      const s = await this.deps.store.findSession(sessionId);
      if (!s) return fail("NOT_FOUND");
      if (!canAccessSession(p, s.userId)) return fail("FORBIDDEN");
    }
    const page = await this.deps.store.listTurns(sessionId, { limit: HISTORY_LIMIT, ...(req.beforeTurnSeq ? { beforeTurnSeq: req.beforeTurnSeq } : {}) });
    const first = page.turns[0];
    return {
      ok: true,
      data: {
        sessionId,
        turns: page.turns.map(toProtocolTurn),
        hasMore: page.hasMore,
        ...(page.hasMore && first ? { nextBeforeTurnSeq: first.turnSeq } : {}),
      },
    };
  }

  async send(p: AuthedPrincipal, req: ChatSendRequest, events: ChatEvents): Promise<Ack<ChatSendResponse>> {
    const session = await this.deps.store.findSession(req.sessionId);
    if (!session) return fail("NOT_FOUND");
    if (!canAccessSession(p, session.userId)) return fail("FORBIDDEN");

    return this.deps.queue.withLock(req.sessionId, async () => {
      // ① 멱등 조회 (큐가 가득 차도 동작)
      const existing = await this.deps.store.findTurnByClientMsgId(req.sessionId, req.clientMsgId);
      if (existing) {
        if (existing.userText !== req.text) return fail<ChatSendResponse>("INVALID_INPUT");
        await this.replay(existing, events);
        return { ok: true, data: { turnId: existing.id, turnSeq: existing.turnSeq, status: "duplicate" } };
      }
      // 레이트 리밋은 새 요청에만 적용(중복 재전송은 복구 경로라 제한하지 않음)
      const limited = this.deps.sendLimiter.take(p.userId);
      if (!limited.ok) return fail<ChatSendResponse>("RATE_LIMITED", limited.retryAfterMs);
      // ② 슬롯 예약
      if (!this.deps.queue.tryReserve(req.sessionId)) return fail<ChatSendResponse>("QUEUE_FULL", QUEUE_FULL_RETRY_MS);
      // ③ DB 원자 예약
      let turn: TurnRow;
      try {
        turn = await this.deps.store.reserveTurn({
          sessionId: req.sessionId,
          clientMsgId: req.clientMsgId,
          userText: req.text,
          ...(req.retryOfTurnSeq ? { retryOfTurnSeq: req.retryOfTurnSeq } : {}),
        });
      } catch {
        this.deps.queue.release(req.sessionId);
        return fail<ChatSendResponse>("INTERNAL");
      }
      // ④ enqueue
      this.inflight.add(turn.id);
      const enqueuedAt = this.now();
      events.status({ sessionId: req.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq, stage: "queued" });
      this.deps.queue.run(req.sessionId, () => this.process(p, turn, enqueuedAt, events));
      return { ok: true, data: { turnId: turn.id, turnSeq: turn.turnSeq, status: "accepted" } };
    });
  }

  /** 이미 있는 턴의 결과를 이벤트로 다시 보낸다. stale processing은 failed(RESTARTED)로 확정한다. */
  private async replay(row: TurnRow, events: ChatEvents): Promise<void> {
    if (row.status === "completed") {
      queueMicrotask(() => events.done(toDoneEvent(row, row.sessionId)));
      return;
    }
    if (row.status === "failed") {
      queueMicrotask(() => events.error(toErrorEvent(row, row.sessionId)));
      return;
    }
    if (!this.inflight.has(row.id)) {
      await this.deps.store.failTurn(row.id, "RESTARTED", true);
      const failed = { ...row, status: "failed" as const, errorCode: "RESTARTED", errorRetryable: true };
      queueMicrotask(() => events.error(toErrorEvent(failed, row.sessionId)));
    }
    // 진행 중이면 처리 완료 시 room 이벤트로 받게 된다
  }

  private async process(p: AuthedPrincipal, turn: TurnRow, enqueuedAt: number, events: ChatEvents): Promise<void> {
    const ref = { sessionId: turn.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq };
    const failWith = async (code: ErrorCode, retryable: boolean) => {
      const changed = await this.deps.store.failTurn(turn.id, code, retryable).catch(() => false);
      if (changed) events.error(toErrorEvent({ ...turn, status: "failed", errorCode: code, errorRetryable: retryable }, turn.sessionId));
    };
    try {
      let snapshot;
      try {
        snapshot = this.deps.snapshots.current();
      } catch {
        await failWith("INTERNAL", false);
        return;
      }
      const { queueMs, engineMs, saveMs } = snapshot.policy.deadlines;
      if (this.now() - enqueuedAt > queueMs) {
        await failWith("QUEUE_TIMEOUT", true);
        return;
      }
      let result: EngineResult;
      try {
        result = await this.engine.handle(
          { principal: p, sessionId: turn.sessionId, turnId: turn.id, turnSeq: turn.turnSeq, text: turn.userText, snapshot, signal: AbortSignal.timeout(engineMs) },
          (prog) => events.status({ ...ref, stage: prog.stage }),
        );
      } catch {
        await failWith("INTERNAL", false);
        return;
      }
      let saved: { traceId: string } | null;
      try {
        saved = await this.deps.store.completeTurn(turn.id, result, { saveMs });
      } catch {
        await failWith("INTERNAL", false);
        return;
      }
      if (!saved) return; // 이미 다른 경로에서 종료됨
      const row: TurnRow = {
        ...turn,
        status: "completed",
        assistantText: result.text,
        route: result.route,
        sources: result.sources,
        traceId: saved.traceId,
        errorCode: result.route === "error" ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
        errorRetryable: result.route === "error" ? true : null,
      };
      events.done(toDoneEvent(row, turn.sessionId));
      if (hasRole(p, "debug")) events.trace(turn.sessionId, { traceId: saved.traceId, trace: JSON.parse(JSON.stringify(result.trace)) });
    } finally {
      this.inflight.delete(turn.id);
      this.deps.queue.release(turn.sessionId);
    }
  }
}

export const newClientMsgId = randomUUID;
```
※ 멱등 재전송 시 레이트 리밋을 적용하지 않는다(설계 4장 멱등 규칙상 중복은 결과 조회 경로). `chat:trace`는 이 서비스가 아니라 Gateway의 `trace()` 구현이 debug 소켓에만 보낸다(Task 4). 서비스는 요청자가 debug일 때만 trace를 내보내고, Gateway는 다시 수신 소켓의 권한을 확인한다.

- [ ] **Step 5: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test -- chat.service && pnpm --filter jev-chat-api typecheck`
Expected: PASS (13건)

- [ ] **Step 6: 커밋**

```bash
git add jev-chat-api
git commit -m "feat(api): ChatService - 수락 임계 구역, 세션 순차 처리, 종료 상태, 멱등 재발송

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Socket.IO Gateway + IoAdapter + ChatModule

**Files:**
- Modify: `jev-chat-api/package.json` (의존성 추가), `jev-chat-api/src/app/main.ts`, `jev-chat-api/src/app/app.module.ts`
- Create: `jev-chat-api/src/app/chat/{io.adapter.ts,chat.gateway.ts}`, `jev-chat-api/src/app/chat.module.ts`, `jev-chat-api/src/app/auth/auth.module.ts`
- Test: `jev-chat-api/src/app/chat/chat.gateway.e2e.spec.ts`

**Interfaces:**
- Consumes: `ChatService`, `AUTH_PROVIDER`, `AuthProvider`, protocol 스키마·이벤트 타입, `SUPPORTED_PROTOCOL_VERSIONS`, `isWithinPayloadLimit`
- Produces:
  - `class ConfiguredIoAdapter extends IoAdapter` — `constructor(app: INestApplicationContext, corsOrigins: string[])`
  - `class ChatGateway` (`/chat`): 미들웨어 인증(`connect_error`의 `err.message`=ErrorCode, `err.data={code, supported?}`), `session:start`, `chat:send` 핸들러(반환값 = ack)
  - `AuthModule`(AUTH_PROVIDER: env.AUTH_MODE=dev → DevAuthProvider), `ChatModule`
  - 테스트 헬퍼 `createTestApp(opts: { judge: Judge; auth: AuthProvider }): Promise<{ app; url; prisma; close }>` (`src/app/testing/test-app.ts`)

- [ ] **Step 1: 의존성 추가**

`pnpm --filter jev-chat-api add @nestjs/websockets@12.1.2 @nestjs/platform-socket.io@12.1.2 socket.io@4.8.3` 그리고 `pnpm --filter jev-chat-api add -D socket.io-client@4.8.3`

- [ ] **Step 2: 테스트 앱 헬퍼와 실패 E2E 테스트 작성**

`jev-chat-api/src/app/testing/test-app.ts`:
```ts
import "reflect-metadata";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { Judge } from "../../core";
import { loadDomainPack } from "../../adapters/knowledge/pack-loader";
import { KnowledgeRepository } from "../../adapters/persistence/knowledge.repository";
import { createPrismaClient, dbConfigFromUrl, resetTestDb } from "../../adapters/persistence/prisma";
import type { AuthProvider } from "../auth/auth.types";
import { AUTH_PROVIDER } from "../auth/auth.types";
import { AppModule } from "../app.module";
import { ConfiguredIoAdapter } from "../chat/io.adapter";
import { validateEnv } from "../config/env.schema";
import { JUDGE } from "../jev.module";

export const MINI_PACK = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

/** TEST_DATABASE_URL 필수. 미니 팩을 import하고 Judge·AuthProvider를 바꿔 끼운 실제 앱을 띄운다. */
export async function createTestApp(opts: { judge: Judge; auth: AuthProvider }): Promise<{ app: INestApplication; url: string; close: () => Promise<void> }> {
  const db = dbConfigFromUrl(process.env.TEST_DATABASE_URL!);
  const prisma = createPrismaClient(db);
  await resetTestDb(prisma);
  await new KnowledgeRepository(prisma).importPack(await loadDomainPack(MINI_PACK));
  await prisma.$disconnect();

  const env = validateEnv({
    NODE_ENV: "test", TYPESAFE_API_KEY: "unused", DB_HOST: db.host, DB_PORT: String(db.port), DB_USER: db.user,
    DB_PASSWORD: db.password, DB_NAME: db.database, AUTH_MODE: "dev", DEV_ACCESS_TOKEN: "t".repeat(32), CORS_ORIGINS: "http://localhost:5173",
  });
  const { Test } = await import("@nestjs/testing");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(JUDGE).useValue(opts.judge)
    .overrideProvider(AUTH_PROVIDER).useValue(opts.auth)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
  await app.listen(0);
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  return { app, url, close: () => app.close() };
}
```
(`tsconfig.build.json`의 `exclude`에 `"src/app/testing/**"` 추가)

`jev-chat-api/src/app/chat/chat.gateway.e2e.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { ChatDoneEvent, ChatTraceEvent, ClientToServerEvents, ServerToClientEvents } from "@jev-chat/protocol";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import { StaticTokenAuthProvider } from "../auth/static-auth.provider";
import { createTestApp } from "../testing/test-app";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const enabled = !!process.env.TEST_DATABASE_URL;

describe.runIf(enabled)("ChatGateway E2E (통합)", () => {
  let url: string;
  let close: () => Promise<void>;
  const clients: Client[] = [];

  beforeAll(async () => {
    const judge = new FakeJudge(
      async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card-limit", confidence: 0.9, probabilities: { "faq-card-limit": 0.95, none: 0.05 } } }),
      async (req) => okRelevance(req.chunk.id, 0.1),
    );
    const auth = new StaticTokenAuthProvider({
      alice: { userId: "alice", roles: ["user"] },
      bob: { userId: "bob", roles: ["user"] },
      dbg: { userId: "carol", roles: ["user", "debug"] },
    });
    ({ url, close } = await createTestApp({ judge, auth }));
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await close?.();
  });

  function connect(token: string, protocolVersion = 1): Promise<Client> {
    const c: Client = io(`${url}/chat`, { auth: { token, protocolVersion }, transports: ["websocket"], reconnection: false, forceNew: true });
    clients.push(c);
    return new Promise((resolve, reject) => {
      c.once("connect", () => resolve(c));
      c.once("connect_error", (e) => reject(e));
    });
  }

  it("잘못된 토큰 → connect_error UNAUTHORIZED", async () => {
    await expect(connect("nope")).rejects.toMatchObject({ message: "UNAUTHORIZED" });
  });

  it("지원하지 않는 프로토콜 버전 → PROTOCOL_UNSUPPORTED", async () => {
    await expect(connect("alice", 99)).rejects.toMatchObject({ message: "PROTOCOL_UNSUPPORTED" });
  });

  it("세션 시작 → 전송 → accepted ack → chat:done(faq)", async () => {
    const c = await connect("alice");
    const start = await c.timeout(3000).emitWithAck("session:start", {});
    expect(start.ok).toBe(true);
    const sessionId = start.ok ? start.data.sessionId : "";
    const done = new Promise<ChatDoneEvent>((r) => c.once("chat:done", r));
    const ack = await c.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    expect(ack).toMatchObject({ ok: true, data: { status: "accepted", turnSeq: 1 } });
    expect(await done).toMatchObject({ route: "faq", turnSeq: 1 });
  });

  it("잘못된 페이로드 → INVALID_INPUT ack", async () => {
    const c = await connect("alice");
    const r = await c.timeout(3000).emitWithAck("chat:send", { sessionId: "x", clientMsgId: "y", text: "" } as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("다른 사용자의 세션 접근 → FORBIDDEN", async () => {
    const a = await connect("alice");
    const start = await a.timeout(3000).emitWithAck("session:start", {});
    const sessionId = start.ok ? start.data.sessionId : "";
    const b = await connect("bob");
    expect(await b.timeout(3000).emitWithAck("session:start", { sessionId })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await b.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "q" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("재연결 동기화: 끊긴 동안 완료된 턴을 session:start로 받는다", async () => {
    const c1 = await connect("alice");
    const start = await c1.timeout(3000).emitWithAck("session:start", {});
    const sessionId = start.ok ? start.data.sessionId : "";
    await c1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    c1.close();
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await connect("alice");
    const again = await c2.timeout(3000).emitWithAck("session:start", { sessionId });
    expect(again.ok && again.data.turns[0]).toMatchObject({ status: "completed", route: "faq" });
  });

  it("debug 권한 소켓만 chat:trace를 받는다", async () => {
    const d = await connect("dbg");
    const start = await d.timeout(3000).emitWithAck("session:start", {});
    const sessionId = start.ok ? start.data.sessionId : "";
    const trace = new Promise<ChatTraceEvent>((r) => d.once("chat:trace", r));
    await d.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    expect((await trace).trace).toMatchObject({ route: "faq" });

    const a = await connect("alice");
    const s2 = await a.timeout(3000).emitWithAck("session:start", {});
    let gotTrace = false;
    a.on("chat:trace", () => (gotTrace = true));
    const done = new Promise((r) => a.once("chat:done", r));
    await a.timeout(3000).emitWithAck("chat:send", { sessionId: s2.ok ? s2.data.sessionId : "", clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    await done;
    expect(gotTrace).toBe(false);
  });
});
```

- [ ] **Step 3: 실행 → 실패 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- chat.gateway`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: IoAdapter·Gateway·모듈 구현**

`jev-chat-api/src/app/chat/io.adapter.ts`:
```ts
import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { ServerOptions } from "socket.io";

/** CORS 허용 목록을 env에서 받는 IoAdapter (데코레이터의 정적 옵션 대신) */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext, private readonly corsOrigins: string[]) {
    super(app);
  }
  override createIOServer(port: number, options?: ServerOptions & { namespace?: string }) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins, credentials: false },
      maxHttpBufferSize: 16 * 1024,
    } as ServerOptions);
  }
}
```

`jev-chat-api/src/app/chat/chat.gateway.ts`:
```ts
import { Inject, Logger } from "@nestjs/common";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayInit } from "@nestjs/websockets";
import {
  ChatSendRequestSchema,
  isWithinPayloadLimit,
  SessionStartRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Ack,
  type ChatSendResponse,
  type ChatTraceEvent,
  type ErrorCode,
  type SessionStartResponse,
} from "@jev-chat/protocol";
import type { Namespace, Socket } from "socket.io";
import type { AuthedPrincipal, AuthProvider } from "../auth/auth.types";
import { AUTH_PROVIDER } from "../auth/auth.types";
import { hasRole } from "../auth/access";
import { ChatService } from "./chat.service";
import type { ChatEvents } from "./chat-events";
import { ERROR_MESSAGES } from "./turn-mapper";

const room = (sessionId: string) => `session:${sessionId}`;
const CHANNEL = "front-test";

type SocketData = { principal: AuthedPrincipal };

function invalid<T>(): Ack<T> {
  return { ok: false, error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT, retryable: false } };
}

function connectError(code: ErrorCode, data: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { data: { code, ...data } });
}

@WebSocketGateway({ namespace: "/chat" })
export class ChatGateway implements OnGatewayInit {
  private readonly log = new Logger(ChatGateway.name);
  @WebSocketServer() private server!: Namespace;

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
  ) {}

  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      void (async () => {
        const { token, protocolVersion } = (socket.handshake.auth ?? {}) as { token?: unknown; protocolVersion?: unknown };
        if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(protocolVersion)) {
          return next(connectError("PROTOCOL_UNSUPPORTED", { supported: SUPPORTED_PROTOCOL_VERSIONS }));
        }
        const principal = typeof token === "string" ? await this.auth.verify(token) : null;
        if (!principal) return next(connectError("UNAUTHORIZED"));
        (socket.data as SocketData).principal = principal;
        if (principal.expiresAt) {
          const ms = principal.expiresAt - Date.now();
          if (ms <= 0) return next(connectError("UNAUTHORIZED"));
          const timer = setTimeout(() => socket.disconnect(true), ms);
          timer.unref();
          socket.once("disconnect", () => clearTimeout(timer));
        }
        next();
      })().catch((e) => {
        this.log.error(`인증 처리 오류: ${(e as Error).name}`);
        next(connectError("INTERNAL"));
      });
    });
  }

  private principal(socket: Socket): AuthedPrincipal {
    return (socket.data as SocketData).principal;
  }

  /** room 기반 이벤트 구현. trace는 room 안의 debug 권한 소켓에만 개별 발송한다. */
  private events(): ChatEvents {
    return {
      status: (e) => this.server.to(room(e.sessionId)).emit("chat:status", e),
      done: (e) => this.server.to(room(e.sessionId)).emit("chat:done", e),
      error: (e) => this.server.to(room(e.sessionId)).emit("chat:error", e),
      trace: (sessionId: string, e: ChatTraceEvent) => {
        void this.server
          .in(room(sessionId))
          .fetchSockets()
          .then((sockets) => {
            for (const s of sockets) {
              const p = (s.data as SocketData | undefined)?.principal;
              if (p && hasRole(p, "debug")) s.emit("chat:trace", e);
            }
          });
      },
    };
  }

  @SubscribeMessage("session:start")
  async onSessionStart(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<SessionStartResponse>> {
    if (!isWithinPayloadLimit(body)) return invalid();
    const parsed = SessionStartRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return invalid();
    const res = await this.chat.startSession(this.principal(socket), parsed.data, CHANNEL);
    if (res.ok) await socket.join(room(res.data.sessionId));
    return res;
  }

  @SubscribeMessage("chat:send")
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<ChatSendResponse>> {
    if (!isWithinPayloadLimit(body)) return invalid();
    const parsed = ChatSendRequestSchema.safeParse(body);
    if (!parsed.success) return invalid();
    const p = this.principal(socket);
    // 권한을 먼저 확인한 뒤 room에 참여한다 → 다른 사용자의 세션 이벤트를 받을 수 없다.
    // (처리 결과 이벤트가 ack보다 먼저 올 수 있으므로 send 호출 전에 참여한다)
    const denied = await this.chat.authorize(p, parsed.data.sessionId);
    if (denied) return denied;
    await socket.join(room(parsed.data.sessionId));
    return this.chat.send(p, parsed.data, this.events());
  }
}
```

`ChatService`에 추가:
```ts
  /** 세션 접근 권한 확인. 허용이면 null, 아니면 실패 ack */
  async authorize(p: AuthedPrincipal, sessionId: string): Promise<Ack<never> | null> {
    const s = await this.deps.store.findSession(sessionId);
    if (!s) return fail("NOT_FOUND");
    if (!canAccessSession(p, s.userId)) return fail("FORBIDDEN");
    return null;
  }
```
그리고 `send()` 앞부분의 세션 조회·권한 확인은 `const denied = await this.authorize(p, req.sessionId); if (denied) return denied;`로 바꾼다(단위 테스트는 그대로 통과해야 한다).

`jev-chat-api/src/app/auth/auth.module.ts`:
```ts
import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env.schema";
import { AUTH_PROVIDER } from "./auth.types";
import { DevAuthProvider } from "./dev-auth.provider";

@Global()
@Module({
  providers: [{ provide: AUTH_PROVIDER, inject: [ENV], useFactory: (env: Env) => new DevAuthProvider(env.DEV_ACCESS_TOKEN ?? "") }],
  exports: [AUTH_PROVIDER],
})
export class AuthModule {}
```

`jev-chat-api/src/app/chat.module.ts`:
```ts
import { Module } from "@nestjs/common";
import type { Judge } from "../core";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import { ChatGateway } from "./chat/chat.gateway";
import { ChatService } from "./chat/chat.service";
import { SlidingWindowRateLimiter } from "./chat/rate-limiter";
import { SessionQueue } from "./chat/session-queue";
import { JUDGE } from "./jev.module";
import { SnapshotService } from "./knowledge/snapshot.service";

@Module({
  providers: [
    {
      provide: ChatService,
      inject: [TurnRepository, SnapshotService, JUDGE],
      useFactory: (store: TurnRepository, snapshots: SnapshotService, judge: Judge) =>
        new ChatService({
          store,
          snapshots,
          judge,
          queue: new SessionQueue({ capacity: 5 }),
          sendLimiter: new SlidingWindowRateLimiter(10, 60_000),
          sessionLimiter: new SlidingWindowRateLimiter(20, 60_000),
        }),
    },
    ChatGateway,
  ],
  exports: [ChatService],
})
export class ChatModule {}
```

`app.module.ts`의 `imports`에 `AuthModule`, `ChatModule` 추가.
`main.ts`에서 `NestFactory.create` 다음 줄에 추가:
```ts
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
```
(import: `import { ConfiguredIoAdapter } from "./chat/io.adapter";`)

- [ ] **Step 5: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test && TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- chat.gateway && pnpm --filter jev-chat-api typecheck`
Expected: 단위 전체 PASS, E2E 7건 PASS. `afterInit`이 `Namespace`를 받는지 확인되지 않으면(미들웨어가 호출되지 않아 인증 테스트 실패) `server.use` 대신 `handleConnection`에서 검증 후 `socket.emit("connect_error")`가 아닌 `socket.disconnect(true)`로 끊고 테스트를 그 동작에 맞추지 말고 **멈추고 보고**한다(설계 계약 변경 필요).

- [ ] **Step 6: 커밋**

```bash
git add jev-chat-api pnpm-lock.yaml
git commit -m "feat(api): Socket.IO /chat Gateway(미들웨어 인증·권한 확인 후 room 참여·debug trace), IoAdapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: REST (세션·턴·trace·검수·관리) + HTTP 인증 가드 + 오류 매핑

**Files:**
- Create: `jev-chat-api/src/app/auth/http-auth.guard.ts`, `jev-chat-api/src/app/rest/{api-error.ts,sessions.controller.ts,traces.controller.ts,admin.controller.ts}`, `jev-chat-api/src/app/rest.module.ts`
- Create: `jev-chat-api/src/adapters/persistence/review.repository.ts`
- Modify: `jev-chat-api/src/adapters/persistence/turn.repository.ts`(세션 목록·trace 조회 추가), `jev-chat-api/src/adapters/persistence/knowledge.repository.ts`(목록 조회 추가), `app.module.ts`
- Test: `jev-chat-api/src/app/rest/rest.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `HttpAuthGuard`(Bearer → `req.principal`), `@Roles(...roles)` 데코레이터 + `RolesGuard`, `@CurrentPrincipal()` 파라미터 데코레이터
  - `class ApiException extends HttpException` — `constructor(code: ErrorCode, retryAfterMs?: number)`, 매핑: UNAUTHORIZED 401, FORBIDDEN 403, NOT_FOUND 404, INVALID_INPUT 400, RATE_LIMITED 429, 그 외 500. 본문 `{ error: { code, message } }`
  - `TurnRepository.listSessions(filter: { userId?: string; route?: string; intent?: string }, page: { cursor?: string; limit: number }): Promise<Page<SessionSummary>>` (cursor = `lastActiveAt ISO|id`)
  - `TurnRepository.findTrace(traceId: string): Promise<{ id; turnId; sessionId; sessionUserId; route; createdAt; data } | null>`
  - `TurnRepository.reviewQueue(page): Promise<Page<ReviewQueueItem>>` — route ∈ {reference, clarify, fallback, error} 또는 faqProb < 0.9, 최신순
  - `ReviewRepository.create(traceId, reviewerId, req: ReviewRequest)`, `listByTrace(traceId)`
  - `KnowledgeRepository.listChunks(versionId, page)`, `listFaqs(versionId, page)`
  - 엔드포인트(설계 4장): `GET /api/sessions`, `GET /api/sessions/:id/turns`, `GET /api/traces/:id`, `GET /api/reviews/queue`, `POST /api/traces/:id/review`, `POST /api/admin/knowledge/reload`, `GET /api/admin/config`, `GET /api/knowledge/chunks`, `GET /api/knowledge/faqs`

- [ ] **Step 1: 실패 E2E 테스트 작성**

`jev-chat-api/src/app/rest/rest.e2e.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { AdminConfigSchema, PageSchema, ReviewQueueItemSchema, SessionSummarySchema, TraceDetailSchema } from "@jev-chat/protocol";
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
    await new Promise((r) => c.once("connect", r));
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

  it("관리: config 조회, 지식 목록, 재로드", async () => {
    expect((await get("/api/admin/config", "alice")).status).toBe(403);
    const cfg = AdminConfigSchema.parse(await (await get("/api/admin/config", "admin")).json());
    expect(cfg).toMatchObject({ packName: "mini-test", model: "jev-1.13.0", templateVersion: "v1" });
    const chunks = await (await get("/api/knowledge/chunks", "admin")).json();
    expect(chunks.items.map((c: { id: string }) => c.id)).toContain("card-001");
    const reload = await post("/api/admin/knowledge/reload", "admin");
    expect(reload.status).toBe(201);
    expect(await reload.json()).toMatchObject({ changed: false });
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- rest.e2e`
Expected: FAIL — 엔드포인트 없음(404)

- [ ] **Step 3: 오류 매핑과 HTTP 가드 구현**

`jev-chat-api/src/app/rest/api-error.ts`:
```ts
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ErrorCode } from "@jev-chat/protocol";
import { ERROR_MESSAGES } from "../chat/turn-mapper";

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_INPUT: HttpStatus.BAD_REQUEST,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
};

export class ApiException extends HttpException {
  constructor(code: ErrorCode, retryAfterMs?: number) {
    super({ error: { code, message: ERROR_MESSAGES[code], ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }, STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
```

`jev-chat-api/src/app/auth/http-auth.guard.ts`:
```ts
import { createParamDecorator, Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "../../core";
import { ApiException } from "../rest/api-error";
import { hasRole } from "./access";
import { AUTH_PROVIDER, type AuthedPrincipal, type AuthProvider } from "./auth.types";

const ROLES = "jev:roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

type Req = { headers: Record<string, string | undefined>; principal?: AuthedPrincipal };

@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const principal = token ? await this.auth.verify(token) : null;
    if (!principal || (principal.expiresAt !== undefined && principal.expiresAt <= Date.now())) throw new ApiException("UNAUTHORIZED");
    req.principal = principal;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.every((r) => hasRole(principal, r))) throw new ApiException("FORBIDDEN");
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthedPrincipal => ctx.switchToHttp().getRequest<Req>().principal!);
```

- [ ] **Step 4: 저장소 조회 메서드 추가**

`turn.repository.ts`에 추가:
```ts
import type { Page, ReviewQueueItem, SessionSummary } from "@jev-chat/protocol";

  async listSessions(filter: { userId?: string; route?: string; intent?: string }, page: { cursor?: string; limit: number }): Promise<Page<SessionSummary>> {
    const [cursorAt, cursorId] = page.cursor ? page.cursor.split("|") : [undefined, undefined];
    const rows = await this.prisma.chatSession.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.route || filter.intent
          ? { turns: { some: { ...(filter.route ? { route: filter.route } : {}), ...(filter.intent ? { trace: { intent: filter.intent } } : {}) } } }
          : {}),
        ...(cursorAt && cursorId
          ? { OR: [{ lastActiveAt: { lt: new Date(cursorAt) } }, { lastActiveAt: new Date(cursorAt), id: { lt: cursorId } }] }
          : {}),
      },
      orderBy: [{ lastActiveAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      include: { _count: { select: { turns: true } } },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((s) => ({
        id: s.id, userId: s.userId, channel: s.channel, createdAt: s.createdAt.toISOString(), lastActiveAt: s.lastActiveAt.toISOString(), turnCount: s._count.turns,
      })),
      nextCursor: rows.length > page.limit && last ? `${last.lastActiveAt.toISOString()}|${last.id}` : null,
    };
  }

  async findTrace(traceId: string) {
    const t = await this.prisma.messageTrace.findUnique({ where: { id: traceId }, include: { turn: { select: { sessionId: true, session: { select: { userId: true } } } } } });
    if (!t) return null;
    return { id: t.id, turnId: t.turnId, sessionId: t.turn.sessionId, sessionUserId: t.turn.session.userId, route: t.route, createdAt: t.createdAt, data: t.data as Record<string, unknown> };
  }

  async reviewQueue(page: { cursor?: string; limit: number }): Promise<Page<ReviewQueueItem>> {
    const [cursorAt, cursorId] = page.cursor ? page.cursor.split("|") : [undefined, undefined];
    const rows = await this.prisma.messageTrace.findMany({
      where: {
        OR: [{ route: { in: ["reference", "clarify", "fallback", "error"] } }, { faqProb: { lt: 0.9 } }],
        ...(cursorAt && cursorId ? { AND: [{ OR: [{ createdAt: { lt: new Date(cursorAt) } }, { createdAt: new Date(cursorAt), id: { lt: cursorId } }] }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      include: { turn: { select: { sessionId: true, userText: true, assistantText: true } }, _count: { select: { reviews: true } } },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((t) => ({
        traceId: t.id, turnId: t.turnId, sessionId: t.turn.sessionId, userText: t.turn.userText, assistantText: t.turn.assistantText,
        route: t.route as ReviewQueueItem["route"], intent: t.intent, faqProb: t.faqProb, reviewed: t._count.reviews > 0, createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }
```

`jev-chat-api/src/adapters/persistence/review.repository.ts`:
```ts
import type { Review, ReviewRequest } from "@jev-chat/protocol";
import type { PrismaClient } from "../../generated/prisma/client";

export class ReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(traceId: string, reviewerId: string, req: ReviewRequest): Promise<Review> {
    const r = await this.prisma.messageReview.create({
      data: {
        traceId, reviewerId, verdict: req.verdict, expectedIntent: req.expectedIntent ?? null, expectedFaqId: req.expectedFaqId ?? null,
        expectedChunkIds: req.expectedChunkIds ?? undefined, note: req.note ?? null,
      },
    });
    return this.toDto(r);
  }

  async listByTrace(traceId: string): Promise<Review[]> {
    const rows = await this.prisma.messageReview.findMany({ where: { traceId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => this.toDto(r));
  }

  private toDto(r: { id: string; verdict: "correct" | "wrong" | "partial"; expectedIntent: string | null; expectedFaqId: string | null; expectedChunkIds: unknown; note: string | null; reviewerId: string; createdAt: Date }): Review {
    return {
      id: r.id, verdict: r.verdict, reviewerId: r.reviewerId, createdAt: r.createdAt.toISOString(),
      ...(r.expectedIntent ? { expectedIntent: r.expectedIntent } : {}),
      ...(r.expectedFaqId ? { expectedFaqId: r.expectedFaqId } : {}),
      ...(Array.isArray(r.expectedChunkIds) ? { expectedChunkIds: r.expectedChunkIds as string[] } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  }
}
```

`knowledge.repository.ts`에 추가:
```ts
import type { KnowledgeChunkItem, KnowledgeFaqItem, Page } from "@jev-chat/protocol";

  async listChunks(versionId: string, page: { cursor?: string; limit: number }): Promise<Page<KnowledgeChunkItem>> {
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: { versionId, ...(page.cursor ? { id: { gt: page.cursor } } : {}) },
      orderBy: { id: "asc" },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit);
    return {
      items: items.map((c) => ({ id: c.id, module: c.module, kind: c.kind, title: c.title, section: c.section, text: c.text })),
      nextCursor: rows.length > page.limit ? items.at(-1)!.id : null,
    };
  }

  async listFaqs(versionId: string, page: { cursor?: string; limit: number }): Promise<Page<KnowledgeFaqItem>> {
    const rows = await this.prisma.faq.findMany({
      where: { versionId, ...(page.cursor ? { id: { gt: page.cursor } } : {}) },
      orderBy: { id: "asc" },
      take: page.limit + 1,
      include: { variants: { orderBy: { id: "asc" } } },
    });
    const items = rows.slice(0, page.limit);
    return {
      items: items.map((f) => ({ id: f.id, intent: f.intent, summary: f.summary, answer: f.answer, sourceChunkId: f.sourceChunkId, variants: f.variants.map((v) => v.text) })),
      nextCursor: rows.length > page.limit ? items.at(-1)!.id : null,
    };
  }

  async findVersion(versionId: string): Promise<{ packName: string; packVersion: string } | null> {
    return this.prisma.knowledgeVersion.findUnique({ where: { id: versionId }, select: { packName: true, packVersion: true } });
  }
```

- [ ] **Step 5: 컨트롤러와 모듈 구현**

공통 쿼리 파싱(각 컨트롤러 파일 상단):
```ts
import { z } from "zod";
const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
```

`jev-chat-api/src/app/rest/sessions.controller.ts`:
```ts
import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { Page, SessionSummary, Turn } from "@jev-chat/protocol";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { canAccessSession, hasRole } from "../auth/access";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard } from "../auth/http-auth.guard";
import { toProtocolTurn } from "../chat/turn-mapper";
import { ApiException } from "./api-error";

const ListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  route: z.enum(["faq", "extractive", "reference", "clarify", "blocked", "fallback", "error"]).optional(),
  intent: z.string().max(30).optional(),
});
const TurnsQuery = z.object({ beforeTurnSeq: z.coerce.number().int().min(1).optional() });

@Controller("api/sessions")
@UseGuards(HttpAuthGuard)
export class SessionsController {
  constructor(@Inject(TurnRepository) private readonly turns: TurnRepository) {}

  @Get()
  async list(@CurrentPrincipal() p: AuthedPrincipal, @Query() query: unknown): Promise<Page<SessionSummary>> {
    const q = ListQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.turns.listSessions(
      { ...(hasRole(p, "admin") ? {} : { userId: p.userId }), ...(q.data.route ? { route: q.data.route } : {}), ...(q.data.intent ? { intent: q.data.intent } : {}) },
      { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) },
    );
  }

  @Get(":id/turns")
  async turnsOf(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string, @Query() query: unknown): Promise<{ turns: Turn[]; hasMore: boolean }> {
    if (!z.uuid().safeParse(id).success) throw new ApiException("NOT_FOUND");
    const q = TurnsQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    const s = await this.turns.findSession(id);
    if (!s) throw new ApiException("NOT_FOUND");
    if (!canAccessSession(p, s.userId)) throw new ApiException("FORBIDDEN");
    const page = await this.turns.listTurns(id, { limit: 50, ...(q.data.beforeTurnSeq ? { beforeTurnSeq: q.data.beforeTurnSeq } : {}) });
    return { turns: page.turns.map(toProtocolTurn), hasMore: page.hasMore };
  }
}
```

`jev-chat-api/src/app/rest/traces.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ReviewRequestSchema, type Page, type Review, type ReviewQueueItem, type Route, type TraceDetail } from "@jev-chat/protocol";
import { ReviewRepository } from "../../adapters/persistence/review.repository";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { canAccessSession } from "../auth/access";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard, Roles } from "../auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "../chat/rate-limiter";
import { ApiException } from "./api-error";

const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@Controller("api")
@UseGuards(HttpAuthGuard)
export class TracesController {
  private readonly adminLimiter = new SlidingWindowRateLimiter(30, 60_000);

  constructor(
    @Inject(TurnRepository) private readonly turns: TurnRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
  ) {}

  @Get("traces/:id")
  @Roles("debug")
  async trace(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string): Promise<TraceDetail> {
    const t = z.uuid().safeParse(id).success ? await this.turns.findTrace(id) : null;
    if (!t) throw new ApiException("NOT_FOUND");
    if (!canAccessSession(p, t.sessionUserId)) throw new ApiException("FORBIDDEN");
    return { id: t.id, turnId: t.turnId, sessionId: t.sessionId, route: t.route as Route, createdAt: t.createdAt.toISOString(), data: t.data, reviews: await this.reviews.listByTrace(t.id) };
  }

  @Get("reviews/queue")
  @Roles("admin")
  async queue(@Query() query: unknown): Promise<Page<ReviewQueueItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.turns.reviewQueue({ limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }

  @Post("traces/:id/review")
  @HttpCode(201)
  @Roles("admin")
  async review(@CurrentPrincipal() p: AuthedPrincipal, @Param("id") id: string, @Body() body: unknown): Promise<Review> {
    const limited = this.adminLimiter.take(p.userId);
    if (!limited.ok) throw new ApiException("RATE_LIMITED", limited.retryAfterMs);
    const parsed = ReviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiException("INVALID_INPUT");
    const t = z.uuid().safeParse(id).success ? await this.turns.findTrace(id) : null;
    if (!t) throw new ApiException("NOT_FOUND");
    return this.reviews.create(t.id, p.userId, parsed.data);
  }
}
```

`jev-chat-api/src/app/rest/admin.controller.ts`:
```ts
import { Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { AdminConfig, KnowledgeChunkItem, KnowledgeFaqItem, Page, ReloadResponse } from "@jev-chat/protocol";
import { JEV_MODEL, TEMPLATE_VERSION } from "../../core";
import { KnowledgeRepository } from "../../adapters/persistence/knowledge.repository";
import type { AuthedPrincipal } from "../auth/auth.types";
import { CurrentPrincipal, HttpAuthGuard, Roles } from "../auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "../chat/rate-limiter";
import { NoActiveKnowledgeError, SnapshotService } from "../knowledge/snapshot.service";
import { ApiException } from "./api-error";

const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller("api")
@UseGuards(HttpAuthGuard)
@Roles("admin")
export class AdminController {
  private readonly reloadLimiter = new SlidingWindowRateLimiter(6, 60_000);

  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(KnowledgeRepository) private readonly knowledge: KnowledgeRepository,
  ) {}

  private activeVersion(): string {
    try {
      return this.snapshots.current().knowledgeVersionId;
    } catch (e) {
      if (e instanceof NoActiveKnowledgeError) throw new ApiException("NOT_FOUND");
      throw e;
    }
  }

  @Get("admin/config")
  async config(): Promise<AdminConfig> {
    let snap = null;
    try {
      snap = this.snapshots.current();
    } catch {
      snap = null;
    }
    const v = snap ? await this.knowledge.findVersion(snap.knowledgeVersionId) : null;
    return {
      knowledgeVersionId: snap?.knowledgeVersionId ?? null,
      packName: v?.packName ?? null,
      packVersion: v?.packVersion ?? null,
      model: JEV_MODEL,
      templateVersion: TEMPLATE_VERSION,
      policy: snap ? (JSON.parse(JSON.stringify(snap.policy)) as Record<string, unknown>) : null,
    };
  }

  @Post("admin/knowledge/reload")
  @HttpCode(201)
  async reload(@CurrentPrincipal() p: AuthedPrincipal): Promise<ReloadResponse> {
    const limited = this.reloadLimiter.take(p.userId);
    if (!limited.ok) throw new ApiException("RATE_LIMITED", limited.retryAfterMs);
    try {
      return await this.snapshots.reload();
    } catch (e) {
      if (e instanceof NoActiveKnowledgeError) throw new ApiException("NOT_FOUND");
      throw new ApiException("INTERNAL");
    }
  }

  @Get("knowledge/chunks")
  async chunks(@Query() query: unknown): Promise<Page<KnowledgeChunkItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.knowledge.listChunks(this.activeVersion(), { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }

  @Get("knowledge/faqs")
  async faqs(@Query() query: unknown): Promise<Page<KnowledgeFaqItem>> {
    const q = PageQuery.safeParse(query);
    if (!q.success) throw new ApiException("INVALID_INPUT");
    return this.knowledge.listFaqs(this.activeVersion(), { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  }
}
```

`jev-chat-api/src/app/rest.module.ts`:
```ts
import { Module } from "@nestjs/common";
import type { PrismaClient } from "../generated/prisma/client";
import { ReviewRepository } from "../adapters/persistence/review.repository";
import { HttpAuthGuard } from "./auth/http-auth.guard";
import { PRISMA } from "./persistence.module";
import { AdminController } from "./rest/admin.controller";
import { SessionsController } from "./rest/sessions.controller";
import { TracesController } from "./rest/traces.controller";

@Module({
  controllers: [SessionsController, TracesController, AdminController],
  providers: [HttpAuthGuard, { provide: ReviewRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new ReviewRepository(p) }],
})
export class RestModule {}
```
`app.module.ts`의 `imports`에 `RestModule` 추가.

- [ ] **Step 6: 실행 → 통과 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test && pnpm typecheck`
Expected: REST E2E 7건 포함 전부 PASS

- [ ] **Step 7: 커밋**

```bash
git add jev-chat-api
git commit -m "feat(api): REST - 세션·턴·trace·검수·관리 엔드포인트, Bearer 가드·역할, 오류 매핑

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 보관 기간 정리 + 평가셋 내보내기 CLI + PM2 배포 설정

**Files:**
- Create: `jev-chat-api/src/app/ops/retention.service.ts`, `jev-chat-api/src/scripts/export-reviews.ts`, `ecosystem.config.js`
- Modify: `jev-chat-api/src/adapters/persistence/turn.repository.ts`(`deleteOlderThan`), `jev-chat-api/package.json`(script), `app.module.ts`
- Test: `jev-chat-api/src/adapters/persistence/retention.spec.ts`

**Interfaces:**
- Produces: `TurnRepository.deleteOlderThan(cutoff: Date): Promise<number>`(세션 lastActiveAt 기준, cascade로 턴·trace·검수 삭제), `RetentionService`(부팅 1분 후 + 24시간마다, `unref` 타이머), CLI `pnpm --filter jev-chat-api eval:export-reviews [출력경로]`(검수 결과 → 6장 평가 항목 스키마 jsonl)

- [ ] **Step 1: 실패 테스트 작성**

`jev-chat-api/src/adapters/persistence/retention.spec.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb, testPrisma } from "./prisma";
import { TurnRepository } from "./turn.repository";

const prisma = testPrisma();

describe.runIf(prisma)("보관 기간 정리 (통합)", () => {
  const repo = new TurnRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("마지막 활동이 기준보다 오래된 세션과 그 턴을 삭제한다", async () => {
    const old = await repo.createSession("u", "t");
    const recent = await repo.createSession("u", "t");
    await repo.reserveTurn({ sessionId: old.id, clientMsgId: "00000000-0000-4000-8000-000000000001", userText: "q" });
    await prisma!.chatSession.update({ where: { id: old.id }, data: { lastActiveAt: new Date("2020-01-01") } });
    expect(await repo.deleteOlderThan(new Date("2021-01-01"))).toBe(1);
    expect(await prisma!.chatSession.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma!.chatTurn.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await prisma!.chatSession.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- retention`
Expected: FAIL — `deleteOlderThan` 없음

- [ ] **Step 3: 구현**

`turn.repository.ts`에 추가:
```ts
  /** 마지막 활동이 cutoff 이전인 세션 삭제(턴·trace·검수는 FK cascade). 처리 중 턴이 있는 세션은 건너뛴다. */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const r = await this.prisma.chatSession.deleteMany({
      where: { lastActiveAt: { lt: cutoff }, turns: { none: { status: "processing" } } },
    });
    return r.count;
  }
```

`jev-chat-api/src/app/ops/retention.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { ENV, type Env } from "../config/env.schema";

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(@Inject(TurnRepository) private readonly turns: TurnRepository, @Inject(ENV) private readonly env: Env) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === "test") return;
    const first = setTimeout(() => void this.sweep(), 60_000);
    const daily = setInterval(() => void this.sweep(), DAY);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearTimeout(t));
  }

  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.env.RETENTION_DAYS * DAY);
    try {
      const n = await this.turns.deleteOlderThan(cutoff);
      if (n > 0) this.log.log(`보관 기간(${this.env.RETENTION_DAYS}일) 지난 세션 ${n}건 삭제`);
      return n;
    } catch (e) {
      this.log.error(`보관 기간 정리 실패: ${(e as Error).name}`);
      return 0;
    }
  }
}
```
`app.module.ts`의 `providers`에 `RetentionService` 추가.

`jev-chat-api/src/scripts/export-reviews.ts`:
```ts
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { validateEnv } from "../app/config/env.schema";

/** 검수 결과(message_reviews)를 설계 6장 평가 항목 형식 jsonl로 내보낸다. 튜닝용(tune) 후보로만 사용한다. */
async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const out = process.argv[2] ?? "eval-from-reviews.jsonl";
  const prisma = createPrismaClient({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, connectionLimit: 2 });
  try {
    const reviews = await prisma.messageReview.findMany({ include: { trace: { include: { turn: true } } }, orderBy: { createdAt: "asc" } });
    const lines = reviews.map((r) => {
      const ok = r.verdict === "correct";
      return JSON.stringify({
        id: `review-${r.id}`,
        type: "from_review",
        turns: [],
        message: r.trace.turn.userText,
        expect: {
          intent: r.expectedIntent ?? r.trace.intent,
          allowed_outcomes: ok ? [routeToOutcome(r.trace.route)] : ["ANSWER", "REFERENCE", "HOLD"],
          ...(r.expectedFaqId ? { faq_ids: [r.expectedFaqId] } : ok && r.trace.faqChoice && r.trace.route === "faq" ? { faq_ids: [r.trace.faqChoice] } : {}),
          ...(Array.isArray(r.expectedChunkIds) ? { acceptable_chunk_ids: r.expectedChunkIds, required_chunk_ids_any: r.expectedChunkIds } : {}),
          attack_goal: null,
        },
      });
    });
    writeFileSync(out, lines.join("\n") + (lines.length ? "\n" : ""));
    console.log(`검수 ${reviews.length}건 → ${out}`);
  } finally {
    await prisma.$disconnect();
  }
}

function routeToOutcome(route: string): string {
  if (route === "faq" || route === "extractive") return "ANSWER";
  if (route === "reference") return "REFERENCE";
  if (route === "blocked") return "BLOCK";
  if (route === "error") return "ERROR";
  return "HOLD";
}

void main();
```
`jev-chat-api/package.json` scripts에 `"eval:export-reviews": "tsx src/scripts/export-reviews.ts"` 추가.

`ecosystem.config.js` (루트):
```js
// PM2 설정. 시크릿을 넣지 않는다 — jev-chat-api/.env(서버에만 존재, 권한 600)를 앱이 dotenv로 읽는다.
module.exports = {
  apps: [
    {
      name: "jev-chat-api",
      cwd: "./jev-chat-api",
      script: "dist/app/main.js",
      exec_mode: "fork",
      instances: 1, // Socket.IO 세션 큐·멱등 진행 목록이 프로세스 메모리에 있으므로 단일 인스턴스
      max_memory_restart: "512M",
      kill_timeout: 10000, // 진행 중 처리 마무리 시간
      env: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production" },
    },
  ],
};
```
※ 현재 `AUTH_MODE`는 `dev`뿐이라 `--env production`으로는 시작이 거부된다(설계 8장 출시 조건 ③). 사내 테스트 서버는 `pm2 start ecosystem.config.js`(development)로 띄운다.

- [ ] **Step 4: 실행 → 통과 + 빌드 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test && pnpm --filter jev-chat-api build && node -e "require('./ecosystem.config.js')"`
Expected: 전부 PASS, `jev-chat-api/dist/app/main.js` 생성, ecosystem 파일 문법 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add ecosystem.config.js jev-chat-api
git commit -m "feat(api): 보관 기간 정리, 검수→평가 항목 내보내기 CLI, PM2 ecosystem

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 완료 조건 (계획 2B)
- `pnpm test`, `pnpm typecheck`, `pnpm --filter jev-chat-api build` 통과
- `TEST_DATABASE_URL`로 Gateway E2E 7건·REST E2E 7건·보관 기간 1건을 포함한 통합 테스트 전부 통과(skip 0건 결과를 보고에 기록)
- 수동 스모크: 미니 팩 import → `pnpm start:dev` → `socket.io-client`로 접속해 질문 1건 → `chat:done` 수신(가짜가 아닌 **실제 Jev 키**로 1회 확인, 응답 trace의 `jevCalls[].usage`와 `estimatedInputTokens` 비교 기록)
- 계획 4(front)가 사용할 것: 소켓 이벤트·ack 계약, REST 엔드포인트와 `packages/protocol`의 REST DTO
