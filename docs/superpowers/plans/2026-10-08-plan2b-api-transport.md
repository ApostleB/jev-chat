# 계획 2B: API 전송 계층 (인증 · 수락 큐 · Gateway · REST · 운영) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 계획 2A의 기반 위에 실제로 대화할 수 있는 서버를 완성한다 — 인증·권한, 세션별 수락 임계 구역과 큐, ChatEngine 실행과 저장을 묶는 ChatService, Socket.IO `/chat` Gateway, jev-front용 REST, 보관 기간 정리, PM2 배포 설정.

**Architecture:** `src/app/`에 Nest 계층을 둔다. 순수 로직(수락 큐, 레이트 리밋, 인증 판정, 행 → 프로토콜 매핑)은 Nest 없이 단위 테스트 가능한 클래스로 만들고, Gateway·Controller는 얇게 유지한다. ChatService는 저장소 인터페이스(`TurnStore`)와 이벤트 인터페이스(`ChatEvents`)에만 의존해 transport를 바꿔도 재사용된다. 통합·E2E는 `TEST_DATABASE_URL` + 가짜 Judge로 실행한다(실제 Jev 키 불필요).

**Tech Stack:** NestJS 12.1.2 (`@nestjs/websockets`, `@nestjs/platform-socket.io`), socket.io 4.8.3 / socket.io-client 4.8.3, zod ^4.6, Vitest ^5 + unplugin-swc

**설계 문서:** `docs/superpowers/specs/2026-10-08-jev-chat-design.md` v3 — 1장(수락·처리·종료 상태 매핑), 4장(소켓 프로토콜·REST·권한), 6장(테스트 계층), 0장 결정 9(PM2).
**선행:** 계획 1 + 체크포인트 1 수정, 계획 2A 완료.
**개정:** Codex 사전 검토(`docs/reviews/2026-10-08-plan2b-plan-review-codex.md`, B1~B11) 반영본. 반영 위치에 `[B#]` 표시.

## Global Constraints

- 계획 1·2A의 Global Constraints를 모두 따른다(한국어, 커밋 trailer, core 수정 금지, `.env*` 읽기 금지, push 금지, 버전 고정).
- `socket.io`와 `socket.io-client`는 **4.8.3으로 고정**한다(`@nestjs/platform-socket.io@12.1.2`가 socket.io를 4.8.3으로 고정 의존하므로 타입 불일치를 피한다).
- 모든 수신 페이로드는 `packages/protocol`의 zod 스키마로 검증하고, `isWithinPayloadLimit`(8KB)를 먼저 적용한다.
- 권한: 모든 소켓 이벤트·REST 요청에서 principal을 확인하고, 세션 접근은 `session.userId === principal.userId` 또는 `admin`. `chat:trace`는 debug 권한 소켓에만 개별 발송(broadcast 금지).
- 오류 응답에 스택·내부 메시지·키·SQL을 넣지 않는다. 클라이언트에는 프로토콜 `ErrorCode`와 한국어 안내 문장만.
- 레이트 리밋(사용자 ID 기준, 재연결 무관): 메시지 분당 10건, 세션 생성 분당 20건, 관리 API 분당 30건, 지식 재로드 분당 6회.
- 세션당 대기+처리 최대 5건, 큐 대기 상한은 실행 스냅샷 `policy.deadlines.queueMs`(기본 10000), 엔진 기한 `engineMs`(8000), 저장 기한 `saveMs`(3000).
- 이벤트는 저장 결과를 확인한 **뒤에만** 보낸다(저장 실패를 성공으로 알리지 않음).
- [B1] 소켓 핸들러·REST는 어떤 예외에서도 정해진 실패 형식(ack `INTERNAL` / `ApiError`)으로 응답한다. 로그에는 예외 이름만 남기고 값·SQL·스택을 클라이언트에 보내지 않는다.
- [B3] 처리 결과 이벤트는 ack보다 먼저 도착할 수 있다. 클라이언트는 `clientMsgId`/`turnSeq` 기준 upsert로 정리한다(계획 4 계약).
- [B5] WebSocket handshake에서 Origin 허용 목록을 검사한다(CORS는 polling에만 적용되므로). Origin 헤더가 없는 비브라우저 클라이언트는 토큰 인증만으로 허용한다.

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
    expect(ApiErrorSchema.parse({ error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 1500 } }).error.retryAfterMs).toBe(1500);
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

export const ApiErrorSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string(), retryAfterMs: z.number().int().nonnegative().optional() }),
});
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
  - `type ReplyPort = Pick<ChatEvents, "done" | "error">` — 요청한 소켓 하나에만 보내는 포트 [B7]
  - `class ChatService` — `constructor(deps: { store: TurnStore; snapshots: Pick<SnapshotService, "current">; judge: Judge; queue: SessionQueue; sendLimiter: SlidingWindowRateLimiter; sessionLimiter: SlidingWindowRateLimiter; replayLimiter: SlidingWindowRateLimiter; log?: (where: string, err: unknown) => void })`
  - `authorize(p: AuthedPrincipal, sessionId: string): Promise<Ack<never> | null>` (허용이면 null, 조회 실패는 `INTERNAL`) [B1]
  - `startSession(p: AuthedPrincipal, req: SessionStartRequest, channel: string, join: (sessionId: string) => Promise<void>): Promise<Ack<SessionStartResponse>>` — **권한 확인/생성 → join → 이력 조회** 순서 [B3]
  - `send(p: AuthedPrincipal, req: ChatSendRequest, events: ChatEvents, reply: ReplyPort): Promise<Ack<ChatSendResponse>>`
  - `inflightCount(): number`

동작 계약(설계 1장):
- `send`: `authorize` 실패 → 해당 ack. `withLock(sessionId)` 안에서 ① 멱등 조회(같은 text → `duplicate` ack + **요청 소켓에만** 결과 재발송[B7], 재발송은 `replayLimiter`(분당 30); 다른 text → `INVALID_INPUT`) ② 새 요청 레이트 리밋 ③ `tryReserve` 실패 → `QUEUE_FULL(retryAfterMs: 2000)`, DB 기록 없음 ④ `reserveTurn` 실패 → 슬롯 반환, `INTERNAL` ⑤ 큐 만료 타이머 설정 후 enqueue. 그 밖의 예외 → `INTERNAL` ack [B1].
- stale processing 재발송 [B2]: 진행 목록에 없으면 `failTurn(RESTARTED)` — **true일 때만** RESTARTED, false면 최신 행을 다시 읽어 실제 결과를 보낸다.
- 큐 만료 [B4]: enqueue 시 `queueMs` 타이머. 실행 전에 만료되면 `failTurn(QUEUE_TIMEOUT, true)`(true일 때만 `chat:error`), 슬롯·진행 목록을 즉시 정확히 한 번 반환, 나중에 차례가 와도 실행하지 않는다.
- 처리: 활성 지식 없음 / 엔진 예외 → `failTurn(INTERNAL, false)`. 정상 → `completeTurn(saveMs)` 확인 후 room에 `chat:done`, 그리고 **항상** `events.trace()`(수신 소켓 debug 필터는 Gateway)[B8]. 저장 실패 → `failTurn(INTERNAL, false)` 후 `chat:error`. 모든 경로에서 슬롯·진행 목록 정확히 한 번 반환.

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
  /** [B1] 지정한 메서드가 예외를 던지게 한다 */
  throwOn = new Set<string>();
  /** [B2] failTurn 직전에 실행(경합 재현용) */
  beforeFail: (() => void) | null = null;
  readonly calls: string[] = [];

  async createSession(userId: string, _channel: string) {
    const id = randomUUID();
    this.sessions.set(id, { id, userId, next: 1 });
    return { id };
  }
  async findSession(id: string) {
    this.calls.push("findSession");
    if (this.throwOn.has("findSession")) throw new Error("db down");
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
    this.beforeFail?.();
    const t = this.turns.find((x) => x.id === turnId);
    if (!t || t.status !== "processing") return false;
    Object.assign(t, { status: "failed", errorCode: code, errorRetryable: retryable });
    return true;
  }
  async listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }) {
    this.calls.push("listTurns");
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
import { DEFAULT_POLICY, type Judge, type Policy } from "../../core";
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

class Recorder implements ChatEvents {
  log: string[] = [];
  statuses: ChatStatusEvent[] = [];
  dones: ChatDoneEvent[] = [];
  errors: ChatErrorEvent[] = [];
  traces: ChatTraceEvent[] = [];
  status(e: ChatStatusEvent) { this.statuses.push(e); this.log.push(`status:${e.stage}`); }
  done(e: ChatDoneEvent) { this.dones.push(ChatDoneEventSchema.parse(e)); this.log.push("done"); }
  error(e: ChatErrorEvent) { this.errors.push(ChatErrorEventSchema.parse(e)); this.log.push(`error:${e.code}`); }
  trace(_s: string, e: ChatTraceEvent) { this.traces.push(e); this.log.push("trace"); }
}

const faqJudge = () =>
  new FakeJudge(
    async () => okTurn({ regulation: 1 }, { faq: { choice: "faq-card", confidence: 0.9, probabilities: { "faq-card": 0.95, none: 0.05 } } }),
    async (req) => okRelevance(req.chunk.id, 0.1),
  );

function setup(opts: { judge?: Judge; capacity?: number; sendLimit?: number; policy?: Policy } = {}) {
  const store = new InMemoryTurnStore();
  const snap = makeSnapshot({ chunks, faqs, ...(opts.policy ? { policy: opts.policy } : {}) });
  const svc = new ChatService({
    store,
    snapshots: { current: () => snap },
    judge: opts.judge ?? faqJudge(),
    queue: new SessionQueue({ capacity: opts.capacity ?? 5 }),
    sendLimiter: new SlidingWindowRateLimiter(opts.sendLimit ?? 10, 60_000),
    sessionLimiter: new SlidingWindowRateLimiter(20, 60_000),
    replayLimiter: new SlidingWindowRateLimiter(30, 60_000),
    log: () => {},
  });
  return { store, svc };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const noJoin = async () => {};

async function session(svc: ChatService, p = alice) {
  const r = await svc.startSession(p, {}, "front-test", noJoin);
  if (!r.ok) throw new Error("session");
  return r.data.sessionId;
}

const send = (svc: ChatService, p: typeof alice, sessionId: string, text: string, ev = new Recorder(), reply = new Recorder(), clientMsgId = randomUUID()) =>
  svc.send(p, { sessionId, clientMsgId, text }, ev, reply);

describe("ChatService", () => {
  it("정상 흐름: status(queued) → accepted ack → status → done(저장 후) → trace(항상 포트로)", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const ev = new Recorder();
    const ack = await send(svc, alice, sid, "법인카드 한도 얼마예요", ev);
    ev.log.push("ack");
    expect(ack).toMatchObject({ ok: true, data: { status: "accepted", turnSeq: 1 } });
    await settle();
    expect(ev.log).toEqual(["status:queued", "ack", "status:judging", "status:answering", "done", "trace"]);
    expect(ev.dones[0]).toMatchObject({ route: "faq", turnSeq: 1 });
    expect(store.turns[0]?.status).toBe("completed");
  });

  it("다른 사용자의 세션 → FORBIDDEN, 없는 세션 → NOT_FOUND", async () => {
    const { svc } = setup();
    const sid = await session(svc, alice);
    expect(await send(svc, bob, sid, "q")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await send(svc, alice, randomUUID(), "q")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("[B1] 저장소 조회 예외 → INTERNAL ack(예외를 던지지 않음), 슬롯 누수 없음", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    store.throwOn.add("findSession");
    expect(await send(svc, alice, sid, "q")).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await svc.startSession(alice, { sessionId: sid }, "front-test", noJoin)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    store.throwOn.clear();
    expect((await send(svc, alice, sid, "법인카드 한도 얼마예요")).ok).toBe(true);
    await settle();
    expect(svc.inflightCount()).toBe(0);
  });

  it("[B7] 멱등 재전송: duplicate ack, 결과는 요청 소켓(reply)에만 재발송", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await send(svc, alice, sid, "법인카드 한도 얼마예요", new Recorder(), new Recorder(), id);
    await settle();
    const room = new Recorder();
    const reply = new Recorder();
    expect(await send(svc, alice, sid, "법인카드 한도 얼마예요", room, reply, id)).toMatchObject({ ok: true, data: { status: "duplicate", turnSeq: 1 } });
    await settle();
    expect(reply.dones).toHaveLength(1);
    expect(room.dones).toHaveLength(0);
    expect(store.turns).toHaveLength(1);
  });

  it("멱등: 같은 clientMsgId + 다른 text → INVALID_INPUT", async () => {
    const { svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await send(svc, alice, sid, "a", new Recorder(), new Recorder(), id);
    expect(await send(svc, alice, sid, "b", new Recorder(), new Recorder(), id)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("stale processing 재전송 → failTurn 성공 시에만 RESTARTED", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    await store.reserveTurn({ sessionId: sid, clientMsgId: id, userText: "q" });
    const reply = new Recorder();
    await send(svc, alice, sid, "q", new Recorder(), reply, id);
    await settle();
    expect(reply.errors[0]).toMatchObject({ code: "RESTARTED", retryable: true });
  });

  it("[B2] stale 조회 후 그 사이 완료됐다면 RESTARTED가 아니라 실제 결과를 보낸다", async () => {
    const { store, svc } = setup();
    const sid = await session(svc);
    const id = randomUUID();
    const row = await store.reserveTurn({ sessionId: sid, clientMsgId: id, userText: "q" });
    store.beforeFail = () => Object.assign(row, { status: "completed", assistantText: "이미 완료", route: "faq", sources: [], traceId: "tr-x" });
    const reply = new Recorder();
    await send(svc, alice, sid, "q", new Recorder(), reply, id);
    await settle();
    expect(reply.errors).toHaveLength(0);
    expect(reply.dones[0]).toMatchObject({ text: "이미 완료", traceId: "tr-x" });
  });

  it("세션 대기+처리 capacity 초과 → QUEUE_FULL, DB 기록 없음, 슬롯 반환 후 다시 가능", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const { store, svc } = setup({ judge, capacity: 2 });
    const sid = await session(svc);
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
    expect(await send(svc, alice, sid, "법인카드")).toMatchObject({ ok: false, error: { code: "QUEUE_FULL", retryAfterMs: 2000 } });
    expect(store.turns).toHaveLength(2);
    release();
    await settle();
    expect((await send(svc, alice, sid, "법인카드")).ok).toBe(true);
  });

  it("레이트 리밋 → RATE_LIMITED + retryAfterMs", async () => {
    const { svc } = setup({ sendLimit: 1 });
    const sid = await session(svc);
    await send(svc, alice, sid, "a");
    const r = await send(svc, alice, sid, "b");
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!r.ok) expect(r.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("세션 내 순차 처리: 두 번째 턴은 첫 턴 완료 후 그 문맥을 본다", async () => {
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.9));
    const { svc } = setup({ judge });
    const sid = await session(svc);
    await send(svc, alice, sid, "법인카드 한도");
    await send(svc, alice, sid, "그럼 회식비는요?");
    await settle();
    expect(judge.turnCalls[1]?.recentTurns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("[B4] 앞 작업이 끝나지 않아도 queueMs가 지나면 즉시 QUEUE_TIMEOUT, 슬롯 회수, 나중에도 실행 안 함", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const judge = new FakeJudge(async () => { await gate; return okTurn({ regulation: 1 }); }, async (req) => okRelevance(req.chunk.id, 0.9));
    const policy: Policy = { ...DEFAULT_POLICY, deadlines: { ...DEFAULT_POLICY.deadlines, queueMs: 50 } };
    const { store, svc } = setup({ judge, policy, capacity: 2 });
    const sid = await session(svc);
    await send(svc, alice, sid, "법인카드 첫째");
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드 둘째", ev);
    await settle(120); // 앞 작업은 여전히 대기 중
    expect(ev.errors[0]).toMatchObject({ code: "QUEUE_TIMEOUT", retryable: true });
    expect(store.turns[1]?.status).toBe("failed");
    expect((await send(svc, alice, sid, "법인카드 셋째")).ok).toBe(true); // 슬롯 회수(capacity 2)
    release();
    await settle(80);
    expect(judge.turnCalls.map((c) => c.message)).not.toContain("법인카드 둘째");
  });

  it("엔진 예외 → failed(INTERNAL) + chat:error, 큐는 계속 동작", async () => {
    const judge: Judge = { judgeTurn: async () => { throw new Error("bug"); }, judgeRelevance: async () => { throw new Error("bug"); } };
    const { store, svc } = setup({ judge });
    const sid = await session(svc);
    const ev = new Recorder();
    await send(svc, alice, sid, "법인카드", ev);
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
    await send(svc, alice, sid, "법인카드 한도 얼마예요", ev);
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
    await send(svc, alice, sid, "법인카드", ev);
    await settle();
    expect(ev.dones[0]).toMatchObject({ route: "error", error: { code: "JEV_UNAVAILABLE", retryable: true } });
  });

  it("[B3] startSession: join이 이력 조회보다 먼저, 권한 없으면 join 안 함, 최신 50턴 + hasMore", async () => {
    const { store, svc } = setup();
    const created = await svc.startSession(alice, {}, "front-test", noJoin);
    expect(created).toMatchObject({ ok: true, data: { turns: [], hasMore: false } });
    const sid = created.ok ? created.data.sessionId : "";
    for (let i = 0; i < 52; i++) await store.reserveTurn({ sessionId: sid, clientMsgId: randomUUID(), userText: `q${i}` });
    store.calls.length = 0;
    const r = await svc.startSession(alice, { sessionId: sid }, "front-test", async () => void store.calls.push("join"));
    expect(store.calls.indexOf("join")).toBeLessThan(store.calls.indexOf("listTurns"));
    expect(r.ok && r.data.turns.length).toBe(50);
    expect(r.ok && r.data.hasMore).toBe(true);
    expect(r.ok && r.data.nextBeforeTurnSeq).toBe(3);
    let joined = false;
    expect(await svc.startSession(bob, { sessionId: sid }, "front-test", async () => void (joined = true))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(joined).toBe(false);
  });
});
```

- [ ] **Step 3: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- chat.service`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`jev-chat-api/src/app/chat/chat.service.ts`:
```ts
import type {
  Ack,
  ChatSendRequest,
  ChatSendResponse,
  ErrorCode,
  SessionStartRequest,
  SessionStartResponse,
} from "@jev-chat/protocol";
import { ChatEngine, DEFAULT_POLICY, ExtractiveAnswerer, type EngineResult, type ExecutionSnapshot, type Judge } from "../../core";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import type { AuthedPrincipal } from "../auth/auth.types";
import { canAccessSession } from "../auth/access";
import type { SnapshotService } from "../knowledge/snapshot.service";
import type { ChatEvents } from "./chat-events";
import type { SlidingWindowRateLimiter } from "./rate-limiter";
import type { SessionQueue } from "./session-queue";
import { ERROR_MESSAGES, toDoneEvent, toErrorEvent, toProtocolTurn } from "./turn-mapper";
import type { TurnStore } from "./turn-store";

const HISTORY_LIMIT = 50;
const QUEUE_FULL_RETRY_MS = 2000;

/** [B7] 요청한 소켓 하나에만 보내는 포트 */
export type ReplyPort = Pick<ChatEvents, "done" | "error">;

interface Deps {
  store: TurnStore;
  snapshots: Pick<SnapshotService, "current">;
  judge: Judge;
  queue: SessionQueue;
  sendLimiter: SlidingWindowRateLimiter;
  sessionLimiter: SlidingWindowRateLimiter;
  replayLimiter: SlidingWindowRateLimiter;
  /** 예외 이름만 기록한다(값·SQL·스택 금지) */
  log?: (where: string, err: unknown) => void;
}

/** [B4] 큐에 들어간 턴의 상태. 만료와 실행 중 하나만 일어난다. */
interface QueuedTurn {
  started: boolean;
  expired: boolean;
  timer: NodeJS.Timeout | null;
}

function fail<T>(code: ErrorCode, retryAfterMs?: number): Ack<T> {
  const retryable = code === "RATE_LIMITED" || code === "QUEUE_FULL" || code === "INTERNAL";
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
}

export class ChatService {
  private readonly inflight = new Set<string>();
  private readonly engine: ChatEngine;
  private readonly log: (where: string, err: unknown) => void;

  constructor(private readonly deps: Deps) {
    this.engine = new ChatEngine({ judge: deps.judge, answerer: new ExtractiveAnswerer(), contextReader: deps.store });
    this.log = deps.log ?? (() => {});
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  /** 세션 접근 권한. 허용이면 null. [B1] 조회 실패는 INTERNAL */
  async authorize(p: AuthedPrincipal, sessionId: string): Promise<Ack<never> | null> {
    try {
      const s = await this.deps.store.findSession(sessionId);
      if (!s) return fail("NOT_FOUND");
      if (!canAccessSession(p, s.userId)) return fail("FORBIDDEN");
      return null;
    } catch (e) {
      this.log("authorize", e);
      return fail("INTERNAL");
    }
  }

  /** [B3] 권한 확인(또는 생성) → join → 이력 조회. 조회 이후의 완료 이벤트는 이미 room에서 받는다. */
  async startSession(
    p: AuthedPrincipal,
    req: SessionStartRequest,
    channel: string,
    join: (sessionId: string) => Promise<void>,
  ): Promise<Ack<SessionStartResponse>> {
    try {
      let sessionId = req.sessionId;
      if (!sessionId) {
        const limited = this.deps.sessionLimiter.take(p.userId);
        if (!limited.ok) return fail("RATE_LIMITED", limited.retryAfterMs);
        sessionId = (await this.deps.store.createSession(p.userId, channel)).id;
      } else {
        const denied = await this.authorize(p, sessionId);
        if (denied) return denied;
      }
      await join(sessionId);
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
    } catch (e) {
      this.log("startSession", e);
      return fail("INTERNAL");
    }
  }

  async send(p: AuthedPrincipal, req: ChatSendRequest, events: ChatEvents, reply: ReplyPort): Promise<Ack<ChatSendResponse>> {
    const denied = await this.authorize(p, req.sessionId);
    if (denied) return denied;
    try {
      return await this.deps.queue.withLock(req.sessionId, async () => {
        // ① 멱등 조회 (큐가 가득 차도 동작)
        const existing = await this.deps.store.findTurnByClientMsgId(req.sessionId, req.clientMsgId);
        if (existing) {
          if (existing.userText !== req.text) return fail<ChatSendResponse>("INVALID_INPUT");
          const limited = this.deps.replayLimiter.take(p.userId);
          if (!limited.ok) return fail<ChatSendResponse>("RATE_LIMITED", limited.retryAfterMs);
          await this.replay(existing, reply);
          return { ok: true, data: { turnId: existing.id, turnSeq: existing.turnSeq, status: "duplicate" } };
        }
        // ② 새 요청 레이트 리밋
        const limited = this.deps.sendLimiter.take(p.userId);
        if (!limited.ok) return fail<ChatSendResponse>("RATE_LIMITED", limited.retryAfterMs);
        // ③ 슬롯 예약
        if (!this.deps.queue.tryReserve(req.sessionId)) return fail<ChatSendResponse>("QUEUE_FULL", QUEUE_FULL_RETRY_MS);
        // ④ DB 원자 예약
        let turn: TurnRow;
        try {
          turn = await this.deps.store.reserveTurn({
            sessionId: req.sessionId,
            clientMsgId: req.clientMsgId,
            userText: req.text,
            ...(req.retryOfTurnSeq ? { retryOfTurnSeq: req.retryOfTurnSeq } : {}),
          });
        } catch (e) {
          this.deps.queue.release(req.sessionId);
          this.log("reserveTurn", e);
          return fail<ChatSendResponse>("INTERNAL");
        }
        // ⑤ 만료 타이머 + enqueue [B4]
        this.inflight.add(turn.id);
        const state: QueuedTurn = { started: false, expired: false, timer: null };
        state.timer = setTimeout(() => void this.expire(turn, state, events), this.queueMs());
        state.timer.unref?.();
        events.status({ sessionId: req.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq, stage: "queued" });
        this.deps.queue.run(req.sessionId, () => this.process(p, turn, state, events));
        return { ok: true, data: { turnId: turn.id, turnSeq: turn.turnSeq, status: "accepted" } };
      });
    } catch (e) {
      this.log("send", e);
      return fail("INTERNAL");
    }
  }

  private queueMs(): number {
    try {
      return this.deps.snapshots.current().policy.deadlines.queueMs;
    } catch {
      return DEFAULT_POLICY.deadlines.queueMs;
    }
  }

  /** 슬롯·진행 목록을 정확히 한 번 반환 */
  private finish(turn: TurnRow, state: QueuedTurn): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!this.inflight.delete(turn.id)) return;
    this.deps.queue.release(turn.sessionId);
  }

  /** [B4] 실행 전에 대기 상한이 지나면 실패로 확정한다 */
  private async expire(turn: TurnRow, state: QueuedTurn, events: ChatEvents): Promise<void> {
    if (state.started || state.expired) return;
    state.expired = true;
    try {
      const changed = await this.deps.store.failTurn(turn.id, "QUEUE_TIMEOUT", true);
      if (changed) events.error(toErrorEvent({ ...turn, status: "failed", errorCode: "QUEUE_TIMEOUT", errorRetryable: true }, turn.sessionId));
    } catch (e) {
      this.log("expire", e);
    } finally {
      this.finish(turn, state);
    }
  }

  /** [B2][B7] 이미 있는 턴의 결과를 요청 소켓에 다시 보낸다 */
  private async replay(row: TurnRow, reply: ReplyPort): Promise<void> {
    let current: TurnRow = row;
    if (current.status === "processing") {
      if (this.inflight.has(current.id)) return; // 처리 중이면 room 이벤트로 받게 된다
      const changed = await this.deps.store.failTurn(current.id, "RESTARTED", true);
      current = changed
        ? { ...current, status: "failed", errorCode: "RESTARTED", errorRetryable: true }
        : ((await this.deps.store.findTurnByClientMsgId(current.sessionId, current.clientMsgId)) ?? current);
    }
    const final = current;
    if (final.status === "completed") queueMicrotask(() => reply.done(toDoneEvent(final, final.sessionId)));
    else if (final.status === "failed") queueMicrotask(() => reply.error(toErrorEvent(final, final.sessionId)));
  }

  private async process(p: AuthedPrincipal, turn: TurnRow, state: QueuedTurn, events: ChatEvents): Promise<void> {
    if (state.expired) return; // 만료된 작업은 실행하지 않는다(정리는 expire가 함)
    state.started = true;
    if (state.timer) clearTimeout(state.timer);
    const ref = { sessionId: turn.sessionId, clientMsgId: turn.clientMsgId, turnSeq: turn.turnSeq };
    const failWith = async (code: ErrorCode, retryable: boolean) => {
      const changed = await this.deps.store.failTurn(turn.id, code, retryable).catch((e) => (this.log("failTurn", e), false));
      if (changed) events.error(toErrorEvent({ ...turn, status: "failed", errorCode: code, errorRetryable: retryable }, turn.sessionId));
    };
    try {
      let snapshot: ExecutionSnapshot;
      try {
        snapshot = this.deps.snapshots.current();
      } catch (e) {
        this.log("snapshot", e);
        await failWith("INTERNAL", false);
        return;
      }
      const { engineMs, saveMs } = snapshot.policy.deadlines;
      let result: EngineResult;
      try {
        result = await this.engine.handle(
          { principal: p, sessionId: turn.sessionId, turnId: turn.id, turnSeq: turn.turnSeq, text: turn.userText, snapshot, signal: AbortSignal.timeout(engineMs) },
          (prog) => events.status({ ...ref, stage: prog.stage }),
        );
      } catch (e) {
        this.log("engine", e);
        await failWith("INTERNAL", false);
        return;
      }
      let saved: { traceId: string } | null;
      try {
        saved = await this.deps.store.completeTurn(turn.id, result, { saveMs });
      } catch (e) {
        this.log("completeTurn", e);
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
      // [B8] trace는 항상 포트로 보낸다. 받는 소켓의 debug 권한은 Gateway가 거른다.
      events.trace(turn.sessionId, { traceId: saved.traceId, trace: JSON.parse(JSON.stringify(result.trace)) });
    } finally {
      this.finish(turn, state);
    }
  }
}
```
※ 중복 재전송은 새 요청 레이트 리밋 대신 `replayLimiter`(분당 30)만 적용한다[B7]. trace 수신 필터는 Gateway 책임이다[B8].

- [ ] **Step 5: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test -- chat.service && pnpm --filter jev-chat-api typecheck`
Expected: PASS (15건)

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
- Test: `jev-chat-api/src/app/chat/chat.gateway.e2e.spec.ts`, `jev-chat-api/src/app/chat/io.adapter.spec.ts`

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
import type { NestExpressApplication } from "@nestjs/platform-express";
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
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.useBodyParser("json", { limit: "8kb" }); // [B9] main.ts와 동일
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
  await app.listen(0);
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  return { app, url, close: () => app.close() };
}
```
(`tsconfig.build.json`의 `exclude`에 `"src/app/testing/**"` 추가)

`jev-chat-api/src/app/chat/io.adapter.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./io.adapter";

describe("isAllowedOrigin [B5]", () => {
  const allowed = new Set(["http://localhost:5173"]);
  it("허용 목록의 Origin만 통과, Origin 없음(비브라우저)은 통과", () => {
    expect(isAllowedOrigin("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowedOrigin("http://evil.test", allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });
});
```

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
const ALLOWED_ORIGIN = "http://localhost:5173";

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
      admin: { userId: "root", roles: ["user", "debug", "admin"] },
    });
    ({ url, close } = await createTestApp({ judge, auth }));
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await close?.();
  });

  function connect(token: string, opts: { protocolVersion?: number; origin?: string; transport?: "websocket" | "polling" } = {}): Promise<Client> {
    const c: Client = io(`${url}/chat`, {
      auth: { token, protocolVersion: opts.protocolVersion ?? 1 },
      transports: [opts.transport ?? "websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { origin: opts.origin ?? ALLOWED_ORIGIN },
    });
    clients.push(c);
    return new Promise((resolve, reject) => {
      c.once("connect", () => resolve(c));
      c.once("connect_error", (e) => reject(e));
    });
  }

  async function startSession(c: Client, sessionId?: string): Promise<string> {
    const r = await c.timeout(3000).emitWithAck("session:start", sessionId ? { sessionId } : {});
    if (!r.ok) throw new Error(r.error.code);
    return r.data.sessionId;
  }

  it("잘못된 토큰 → connect_error UNAUTHORIZED", async () => {
    await expect(connect("nope")).rejects.toMatchObject({ message: "UNAUTHORIZED" });
  });

  it("지원하지 않는 프로토콜 버전 → PROTOCOL_UNSUPPORTED", async () => {
    await expect(connect("alice", { protocolVersion: 99 })).rejects.toMatchObject({ message: "PROTOCOL_UNSUPPORTED" });
  });

  it("[B5] 허용되지 않은 Origin은 websocket·polling 모두 연결 거부(유효 토큰이어도)", async () => {
    await expect(connect("alice", { origin: "http://evil.test", transport: "websocket" })).rejects.toBeTruthy();
    await expect(connect("alice", { origin: "http://evil.test", transport: "polling" })).rejects.toBeTruthy();
    await expect(connect("alice", { transport: "polling" })).resolves.toBeTruthy();
  });

  it("세션 시작 → 전송 → accepted ack → chat:done(faq)", async () => {
    const c = await connect("alice");
    const sessionId = await startSession(c);
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

  it("다른 사용자의 세션 접근 → FORBIDDEN, room에도 참여하지 않음", async () => {
    const a = await connect("alice");
    const sessionId = await startSession(a);
    const b = await connect("bob");
    let leaked = false;
    b.on("chat:done", () => (leaked = true));
    expect(await b.timeout(3000).emitWithAck("session:start", { sessionId })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await b.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "q" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const done = new Promise((r) => a.once("chat:done", r));
    await a.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    await done;
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
  });

  it("재연결 동기화: 끊긴 동안 완료된 턴을 session:start로 받는다", async () => {
    const c1 = await connect("alice");
    const sessionId = await startSession(c1);
    await c1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    c1.close();
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await connect("alice");
    const again = await c2.timeout(3000).emitWithAck("session:start", { sessionId });
    expect(again.ok && again.data.turns[0]).toMatchObject({ status: "completed", route: "faq" });
  });

  it("[B7] 한 소켓의 중복 재전송은 그 소켓에만 결과를 다시 보낸다", async () => {
    const s1 = await connect("alice");
    const sessionId = await startSession(s1);
    const s2 = await connect("alice");
    await startSession(s2, sessionId);
    let s2Done = 0;
    s2.on("chat:done", () => s2Done++);
    const id = randomUUID();
    const first = new Promise((r) => s1.once("chat:done", r));
    await s1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: id, text: "법인카드 한도 얼마예요?" });
    await first;
    await new Promise((r) => setTimeout(r, 100));
    expect(s2Done).toBe(1); // 원래 완료는 room 전체
    const replay = new Promise((r) => s1.once("chat:done", r));
    expect(await s1.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: id, text: "법인카드 한도 얼마예요?" })).toMatchObject({ ok: true, data: { status: "duplicate" } });
    await replay;
    await new Promise((r) => setTimeout(r, 100));
    expect(s2Done).toBe(1); // 재발송은 s2로 가지 않는다
  });

  it("[B8] 같은 세션 room에서 debug 권한 소켓만 trace를 받는다(요청자가 비debug여도)", async () => {
    const owner = await connect("alice"); // 비debug
    const sessionId = await startSession(owner);
    const observer = await connect("admin"); // debug+admin, 같은 세션 관찰
    await startSession(observer, sessionId);
    let ownerTrace = false;
    owner.on("chat:trace", () => (ownerTrace = true));
    const trace = new Promise<ChatTraceEvent>((r) => observer.once("chat:trace", r));
    const done = new Promise((r) => owner.once("chat:done", r));
    await owner.timeout(3000).emitWithAck("chat:send", { sessionId, clientMsgId: randomUUID(), text: "법인카드 한도 얼마예요?" });
    await done;
    expect((await trace).trace).toMatchObject({ route: "faq" });
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerTrace).toBe(false);
  });
});
```

- [ ] **Step 3: 실행 → 실패 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- chat.gateway`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: IoAdapter·Gateway·모듈 구현**

`jev-chat-api/src/app/chat/io.adapter.ts`:
```ts
import type { IncomingMessage } from "node:http";
import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { ServerOptions } from "socket.io";

/** [B5] Origin 허용 판정. Origin이 없는 비브라우저 클라이언트(CLI·서버 간)는 토큰 인증만으로 허용한다. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}

/** CORS(polling)와 handshake Origin(websocket 포함) 허용 목록을 env로 설정하는 IoAdapter */
export class ConfiguredIoAdapter extends IoAdapter {
  private readonly allowed: ReadonlySet<string>;

  constructor(app: INestApplicationContext, private readonly corsOrigins: string[]) {
    super(app);
    this.allowed = new Set(corsOrigins);
  }

  override createIOServer(port: number, options?: ServerOptions & { namespace?: string }) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins, credentials: false },
      maxHttpBufferSize: 16 * 1024,
      // CORS는 HTTP long-polling에만 적용된다. WebSocket까지 막으려면 handshake에서 직접 검사한다.
      allowRequest: (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
        callback(null, isAllowedOrigin(req.headers.origin, this.allowed));
      },
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
import { ChatService, type ReplyPort } from "./chat.service";
import type { ChatEvents } from "./chat-events";
import { ERROR_MESSAGES } from "./turn-mapper";

const room = (sessionId: string) => `session:${sessionId}`;
const CHANNEL = "front-test";

type SocketData = { principal: AuthedPrincipal };

function failAck<T>(code: ErrorCode): Ack<T> {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable: code === "INTERNAL" } };
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
      })().catch((e: unknown) => {
        this.log.error(`인증 처리 오류: ${(e as Error)?.name ?? "unknown"}`);
        next(connectError("INTERNAL"));
      });
    });
  }

  private principal(socket: Socket): AuthedPrincipal {
    return (socket.data as SocketData).principal;
  }

  /** room 기반 이벤트. [B8] trace는 room 안에서 debug 권한이 있는 소켓에만 개별 발송한다(수신자 기준). */
  private roomEvents(): ChatEvents {
    return {
      status: (e) => this.server.to(room(e.sessionId)).emit("chat:status", e),
      done: (e) => this.server.to(room(e.sessionId)).emit("chat:done", e),
      error: (e) => this.server.to(room(e.sessionId)).emit("chat:error", e),
      trace: (sessionId: string, e: ChatTraceEvent) => {
        this.server
          .in(room(sessionId))
          .fetchSockets()
          .then((sockets) => {
            for (const s of sockets) {
              const p = (s.data as SocketData | undefined)?.principal;
              if (p && hasRole(p, "debug")) s.emit("chat:trace", e);
            }
          })
          .catch((err: unknown) => this.log.warn(`trace 발송 실패: ${(err as Error)?.name ?? "unknown"}`));
      },
    };
  }

  /** [B7] 요청한 소켓 하나에만 보내는 재발송 포트 */
  private replyTo(socket: Socket): ReplyPort {
    return {
      done: (e) => socket.emit("chat:done", e),
      error: (e) => socket.emit("chat:error", e),
    };
  }

  @SubscribeMessage("session:start")
  async onSessionStart(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<SessionStartResponse>> {
    try {
      if (!isWithinPayloadLimit(body)) return failAck("INVALID_INPUT");
      const parsed = SessionStartRequestSchema.safeParse(body ?? {});
      if (!parsed.success) return failAck("INVALID_INPUT");
      // [B3] 서비스가 권한 확인(또는 생성) 뒤 join을 호출하고, 그다음 이력을 조회한다
      return await this.chat.startSession(this.principal(socket), parsed.data, CHANNEL, async (sid) => {
        await socket.join(room(sid));
      });
    } catch (e) {
      this.log.error(`session:start 오류: ${(e as Error)?.name ?? "unknown"}`);
      return failAck("INTERNAL"); // [B1]
    }
  }

  @SubscribeMessage("chat:send")
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack<ChatSendResponse>> {
    try {
      if (!isWithinPayloadLimit(body)) return failAck("INVALID_INPUT");
      const parsed = ChatSendRequestSchema.safeParse(body);
      if (!parsed.success) return failAck("INVALID_INPUT");
      const p = this.principal(socket);
      // 권한을 먼저 확인한 뒤 room에 참여한다 → 다른 사용자의 세션 이벤트를 받을 수 없다.
      // (처리 결과 이벤트가 ack보다 먼저 올 수 있으므로 send 호출 전에 참여한다)
      const denied = await this.chat.authorize(p, parsed.data.sessionId);
      if (denied) return denied;
      await socket.join(room(parsed.data.sessionId));
      return await this.chat.send(p, parsed.data, this.roomEvents(), this.replyTo(socket));
    } catch (e) {
      this.log.error(`chat:send 오류: ${(e as Error)?.name ?? "unknown"}`);
      return failAck("INTERNAL"); // [B1]
    }
  }
}
```

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
import { Logger, Module } from "@nestjs/common";
import type { Judge } from "../core";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import { ChatGateway } from "./chat/chat.gateway";
import { ChatService } from "./chat/chat.service";
import { SlidingWindowRateLimiter } from "./chat/rate-limiter";
import { SessionQueue } from "./chat/session-queue";
import { JUDGE } from "./jev.module";
import { SnapshotService } from "./knowledge/snapshot.service";

const chatLog = new Logger("ChatService");

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
          replayLimiter: new SlidingWindowRateLimiter(30, 60_000),
          log: (where, err) => chatLog.error(`${where} 실패: ${(err as Error)?.name ?? "unknown"}`),
        }),
    },
    ChatGateway,
  ],
  exports: [ChatService],
})
export class ChatModule {}
```

`app.module.ts`의 `imports`에 `AuthModule`, `ChatModule` 추가.
`main.ts`를 다음처럼 바꾼다(Express 앱 타입 + body 8KB 제한[B9] + 소켓 어댑터):
```ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { ConfiguredIoAdapter } from "./chat/io.adapter";
import { validateEnv } from "./config/env.schema";

async function bootstrap(): Promise<void> {
  const env = validateEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));
  app.useBodyParser("json", { limit: "8kb" });
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: false });
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, env.CORS_ORIGINS));
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

void bootstrap();
```

- [ ] **Step 5: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test && TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- chat.gateway && pnpm --filter jev-chat-api typecheck`
Expected: 단위 전체 PASS, E2E 9건 PASS. 다음 경우에는 테스트를 동작에 맞춰 고치지 말고 **멈추고 보고**한다(설계 계약 변경 필요):
- `afterInit`이 `Namespace`를 받지 않아 미들웨어 인증이 호출되지 않는 경우
- socket.io 4.8.3에서 `allowRequest`·`extraHeaders(origin)`가 websocket handshake에 적용되지 않아 Origin 테스트가 실패하는 경우
- `node_modules/socket.io/package.json` 버전이 4.8.3이 아니거나 두 버전이 함께 설치된 경우(`pnpm why socket.io`로 확인)

- [ ] **Step 6: 커밋**

```bash
git add jev-chat-api pnpm-lock.yaml
git commit -m "feat(api): Socket.IO /chat Gateway(미들웨어 인증·권한 확인 후 room 참여·debug trace), IoAdapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: REST (세션·턴·trace·검수·관리) + HTTP 인증 가드 + 오류 매핑

**Files:**
- Create: `jev-chat-api/src/app/auth/http-auth.guard.ts`, `jev-chat-api/src/app/rest/{api-error.ts,all-exceptions.filter.ts,cursor.ts,sessions.controller.ts,traces.controller.ts,admin.controller.ts}`, `jev-chat-api/src/app/rest.module.ts`
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
    const chunks = await (await get("/api/knowledge/chunks", "admin")).json();
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

`jev-chat-api/src/app/rest/all-exceptions.filter.ts` [B1][B9]:
```ts
import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { ErrorCode } from "@jev-chat/protocol";
import { ERROR_MESSAGES } from "../chat/turn-mapper";

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return status < 500 ? "INVALID_INPUT" : "INTERNAL";
}

/** 모든 HTTP 오류를 ApiError 형식({ error: { code, message } })으로 통일한다. 스택·내부 메시지는 응답에 넣지 않는다. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("HTTP");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(body: unknown): void } }>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "error" in body) {
        res.status(status).json(body);
        return;
      }
      const code = codeForStatus(status);
      res.status(status).json({ error: { code, message: ERROR_MESSAGES[code] } });
      return;
    }
    // body-parser 오류(413 entity.too.large, 400 JSON 파싱 실패)는 status 속성을 가진다
    const status = (exception as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT } });
      return;
    }
    this.log.error(`처리되지 않은 예외: ${(exception as Error)?.name ?? "unknown"}`);
    res.status(500).json({ error: { code: "INTERNAL", message: ERROR_MESSAGES.INTERNAL } });
  }
}
```

`jev-chat-api/src/app/rest/cursor.ts` [B9]:
```ts
import { z } from "zod";

/** 세션·검수 큐 커서: `<ISO 시각>|<uuid>` */
export const TimeIdCursor = z
  .string()
  .max(200)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z\|[0-9a-f-]{36}$/, "잘못된 커서")
  .refine((c) => !Number.isNaN(Date.parse(c.split("|")[0]!)), "잘못된 커서");

/** 지식 목록 커서: 청크/FAQ id */
export const IdCursor = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "잘못된 커서");

/** 관리 API 공유 제한(사용자당 분당 30건) 주입 토큰 */
export const ADMIN_LIMITER = Symbol("ADMIN_LIMITER");
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
import { TimeIdCursor } from "./cursor";

const ListQuery = z.object({
  cursor: TimeIdCursor.optional(),
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
import { ADMIN_LIMITER, TimeIdCursor } from "./cursor";

const PageQuery = z.object({ cursor: TimeIdCursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@Controller("api")
@UseGuards(HttpAuthGuard)
export class TracesController {
  constructor(
    @Inject(TurnRepository) private readonly turns: TurnRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(ADMIN_LIMITER) private readonly adminLimiter: SlidingWindowRateLimiter,
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
import { ADMIN_LIMITER, IdCursor } from "./cursor";

const PageQuery = z.object({ cursor: IdCursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller("api")
@UseGuards(HttpAuthGuard)
@Roles("admin")
export class AdminController {
  private readonly reloadLimiter = new SlidingWindowRateLimiter(6, 60_000);

  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(KnowledgeRepository) private readonly knowledge: KnowledgeRepository,
    @Inject(ADMIN_LIMITER) private readonly adminLimiter: SlidingWindowRateLimiter,
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
    // 관리 쓰기 공유 제한(분당 30) + 재로드 전용 제한(분당 6)
    for (const limiter of [this.adminLimiter, this.reloadLimiter]) {
      const limited = limiter.take(p.userId);
      if (!limited.ok) throw new ApiException("RATE_LIMITED", limited.retryAfterMs);
    }
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
import { APP_FILTER } from "@nestjs/core";
import type { PrismaClient } from "../generated/prisma/client";
import { ReviewRepository } from "../adapters/persistence/review.repository";
import { HttpAuthGuard } from "./auth/http-auth.guard";
import { SlidingWindowRateLimiter } from "./chat/rate-limiter";
import { PRISMA } from "./persistence.module";
import { AllExceptionsFilter } from "./rest/all-exceptions.filter";
import { ADMIN_LIMITER } from "./rest/cursor";
import { AdminController } from "./rest/admin.controller";
import { SessionsController } from "./rest/sessions.controller";
import { TracesController } from "./rest/traces.controller";

@Module({
  controllers: [SessionsController, TracesController, AdminController],
  providers: [
    HttpAuthGuard,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: ADMIN_LIMITER, useValue: new SlidingWindowRateLimiter(30, 60_000) },
    { provide: ReviewRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new ReviewRepository(p) },
  ],
})
export class RestModule {}
```
`app.module.ts`의 `imports`에 `RestModule` 추가.

- [ ] **Step 6: 실행 → 통과 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test && pnpm typecheck`
Expected: REST E2E 9건 포함 전부 PASS (레이트 리밋 테스트는 재로드 제한 창을 소진하므로 파일의 **마지막** 테스트로 둔다)

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
- Produces: `TurnRepository.deleteOlderThan(cutoff: Date): Promise<{ turns: number; sessions: number }>`([B11] 턴 createdAt 기준으로 processing이 아닌 턴 삭제 → cascade로 trace·검수 삭제, 그 뒤 턴이 없고 lastActiveAt이 cutoff 이전인 세션 삭제), `RetentionService`(부팅 1분 후 + 24시간마다, `unref` 타이머), CLI `pnpm --filter jev-chat-api eval:export-reviews [출력경로]`(검수 결과 → 6장 평가 항목 스키마 jsonl)

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

  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const OLD = new Date("2020-01-01");
  const CUTOFF = new Date("2021-01-01");

  async function completedTurn(sessionId: string, n: number, createdAt?: Date) {
    const t = await repo.reserveTurn({ sessionId, clientMsgId: uid(n), userText: `q${n}` });
    const trace = await prisma!.messageTrace.create({
      data: { turnId: t.id, knowledgeVersionId: uid(900), templateVersion: "v1", route: "faq", bStatus: "skipped", totalInputTokens: 1, data: {} },
    });
    await prisma!.messageReview.create({ data: { traceId: trace.id, verdict: "correct", reviewerId: "root" } });
    await prisma!.chatTurn.update({ where: { id: t.id }, data: { status: "completed", assistantText: "a", route: "faq", ...(createdAt ? { createdAt } : {}) } });
    return t.id;
  }

  it("[B11] 턴 단위: 기준보다 오래된 완료 턴과 그 trace·검수를 삭제, 같은 세션의 최근 턴은 유지", async () => {
    const s = await repo.createSession("u", "t");
    const oldTurn = await completedTurn(s.id, 1, OLD);
    const recentTurn = await completedTurn(s.id, 2);
    expect(await repo.deleteOlderThan(CUTOFF)).toEqual({ turns: 1, sessions: 0 });
    expect(await prisma!.chatTurn.findUnique({ where: { id: oldTurn } })).toBeNull();
    expect(await prisma!.messageTrace.count({ where: { turnId: oldTurn } })).toBe(0);
    expect(await prisma!.chatTurn.findUnique({ where: { id: recentTurn } })).not.toBeNull();
    expect(await prisma!.messageReview.count()).toBe(1);
  });

  it("[B6] 오래된 processing 턴은 지우지 않는다, 턴이 모두 지워진 오래된 세션은 삭제", async () => {
    const busy = await repo.createSession("u", "t");
    const t = await repo.reserveTurn({ sessionId: busy.id, clientMsgId: uid(10), userText: "q" });
    await prisma!.chatTurn.update({ where: { id: t.id }, data: { createdAt: OLD } });
    await prisma!.chatSession.update({ where: { id: busy.id }, data: { lastActiveAt: OLD } });
    const idle = await repo.createSession("u", "t");
    await completedTurn(idle.id, 11, OLD);
    await prisma!.chatSession.update({ where: { id: idle.id }, data: { lastActiveAt: OLD } });
    expect(await repo.deleteOlderThan(CUTOFF)).toEqual({ turns: 1, sessions: 1 });
    expect(await prisma!.chatTurn.findUnique({ where: { id: t.id } })).not.toBeNull();
    expect(await prisma!.chatSession.findUnique({ where: { id: busy.id } })).not.toBeNull();
    expect(await prisma!.chatSession.findUnique({ where: { id: idle.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- retention`
Expected: FAIL — `deleteOlderThan` 없음 (2건)

- [ ] **Step 3: 구현**

`turn.repository.ts`에 추가:
```ts
  /** [B11] 턴 단위 보관: cutoff 이전에 만들어진 종료된 턴 삭제(trace·검수는 FK cascade) → 빈 오래된 세션 삭제. 처리 중 턴은 지우지 않는다. */
  async deleteOlderThan(cutoff: Date): Promise<{ turns: number; sessions: number }> {
    const turns = await this.prisma.chatTurn.deleteMany({ where: { createdAt: { lt: cutoff }, status: { not: "processing" } } });
    const sessions = await this.prisma.chatSession.deleteMany({ where: { lastActiveAt: { lt: cutoff }, turns: { none: {} } } });
    return { turns: turns.count, sessions: sessions.count };
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
      const r = await this.turns.deleteOlderThan(cutoff);
      if (r.turns + r.sessions > 0) this.log.log(`보관 기간(${this.env.RETENTION_DAYS}일) 정리: 턴 ${r.turns}건, 빈 세션 ${r.sessions}건`);
      return r.turns;
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

type Outcome = "ANSWER" | "REFERENCE" | "HOLD" | "BLOCK" | "ERROR";
type SourceLike = { chunkId: string };

function routeToOutcome(route: string): Outcome {
  if (route === "faq" || route === "extractive") return "ANSWER";
  if (route === "reference") return "REFERENCE";
  if (route === "blocked") return "BLOCK";
  if (route === "error") return "ERROR";
  return "HOLD";
}

/**
 * [B10] 검수 결과를 설계 6장 평가 항목 형식으로 내보낸다(tune 후보 전용).
 * - 원래 대화 문맥(trace.contextTurnSeqs)과 실제 출처를 복원한다.
 * - 라벨을 결정할 수 없는 항목(wrong/partial인데 정답 FAQ·청크가 없음)은 needs-labeling 파일로 분리한다.
 */
async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const out = process.argv[2] ?? "eval-from-reviews.jsonl";
  const needsLabeling = out.replace(/\.jsonl$/, "") + ".needs-labeling.jsonl";
  const prisma = createPrismaClient({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, connectionLimit: 2 });
  try {
    const reviews = await prisma.messageReview.findMany({ include: { trace: { include: { turn: true } } }, orderBy: { createdAt: "asc" } });
    const ready: string[] = [];
    const pending: string[] = [];
    for (const r of reviews) {
      const turn = r.trace.turn;
      const data = r.trace.data as { contextTurnSeqs?: number[] };
      const ctxRows = data.contextTurnSeqs?.length
        ? await prisma.chatTurn.findMany({ where: { sessionId: turn.sessionId, turnSeq: { in: data.contextTurnSeqs } }, orderBy: { turnSeq: "asc" } })
        : [];
      const turns = ctxRows.flatMap((t) => [
        { role: "user", text: t.userText },
        { role: "assistant", text: t.assistantText ?? "", sources: ((t.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId) },
      ]);
      const shown = ((turn.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId);
      const outcome = routeToOutcome(r.trace.route);
      const expectedChunks = Array.isArray(r.expectedChunkIds) ? (r.expectedChunkIds as string[]) : null;

      let expect: Record<string, unknown> | null = null;
      if (r.verdict === "correct") {
        expect = {
          intent: r.expectedIntent ?? r.trace.intent,
          allowed_outcomes: [outcome],
          ...(r.trace.route === "faq" && r.trace.faqChoice ? { faq_ids: [r.trace.faqChoice] } : {}),
          ...(outcome === "ANSWER" || outcome === "REFERENCE" ? { acceptable_chunk_ids: shown, required_chunk_ids_any: shown } : {}),
          attack_goal: null,
        };
      } else if (r.expectedFaqId || expectedChunks) {
        expect = {
          intent: r.expectedIntent ?? r.trace.intent,
          allowed_outcomes: ["ANSWER"],
          ...(r.expectedFaqId ? { faq_ids: [r.expectedFaqId] } : {}),
          ...(expectedChunks ? { acceptable_chunk_ids: expectedChunks, required_chunk_ids_any: expectedChunks } : {}),
          attack_goal: null,
        };
      }
      const item = {
        id: `review-${r.id}`,
        type: turns.length > 0 ? "followup" : "from_review",
        knowledge_version_id: r.trace.knowledgeVersionId,
        turns,
        message: turn.userText,
        ...(expect ? { expect } : { review: { verdict: r.verdict, note: r.note, route: r.trace.route } }),
      };
      (expect ? ready : pending).push(JSON.stringify(item));
    }
    writeFileSync(out, ready.join("\n") + (ready.length ? "\n" : ""));
    writeFileSync(needsLabeling, pending.join("\n") + (pending.length ? "\n" : ""));
    console.log(`검수 ${reviews.length}건 → 평가 후보 ${ready.length}건(${out}), 라벨 필요 ${pending.length}건(${needsLabeling})`);
  } finally {
    await prisma.$disconnect();
  }
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
- `TEST_DATABASE_URL`로 Gateway E2E 9건·REST E2E 9건·보관 기간 2건을 포함한 통합 테스트 전부 통과(skip 0건 결과를 보고에 기록)
- `pnpm why socket.io` 결과 4.8.3 단일 버전
- 수동 스모크: 미니 팩 import → `pnpm start:dev` → `socket.io-client`로 접속해 질문 1건 → `chat:done` 수신(가짜가 아닌 **실제 Jev 키**로 1회 확인, 응답 trace의 `jevCalls[].usage`와 `estimatedInputTokens` 비교 기록)
- 계획 4(front)가 사용할 것: 소켓 이벤트·ack 계약, REST 엔드포인트와 `packages/protocol`의 REST DTO
