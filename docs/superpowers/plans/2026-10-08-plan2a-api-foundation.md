# 계획 2A: API 기반 (설정 · DB · 지식 · Jev 어댑터) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** core 엔진을 실제 인프라에 연결하는 기반을 만든다 — 검증된 설정, MariaDB 스키마와 저장소, domain-pack 가져오기와 실행 스냅샷, TypeSafe Jev 어댑터(전역 제한기·재시도 포함), 그리고 `/api/health`로 부팅을 확인할 수 있는 NestJS 앱.

**Architecture:** `jev-chat-api/src/adapters/`에 외부 의존(Prisma, TypeSafe SDK, 파일 시스템) 구현체를, `jev-chat-api/src/app/`에 NestJS 모듈·설정·DI 조립을 둔다. core(계획 1)는 수정하지 않는다. Jev 호출은 `JevTransport` 인터페이스 뒤에 두어 SDK 없이도 `TypesafeJudge`를 테스트한다. DB 통합 테스트는 `TEST_DATABASE_URL`이 있을 때만 실행한다.

**Tech Stack:** NestJS 12.1.2 (CommonJS 유지, Node ≥ 22.12), Prisma 7.10.0 + `@prisma/adapter-mariadb` 7.10.0, MariaDB 11.8, `@typesafe-ai/sdk` 0.6.0, zod ^4.6, yaml ^2.9, Vitest ^5 + unplugin-swc, tsx

**설계 문서:** `docs/superpowers/specs/2026-10-08-jev-chat-design.md` v3 — 0장(결정 6·8, 저장소 구조), 1장(전역 Jev 제한기), 3장(데이터 모델), 7장(domain-pack 형식).
**선행:** 계획 1 완료 + 체크포인트 1 수정(`2026-10-08-plan1-checkpoint1-fixes.md`) 반영 (`CompletedTurn.sources`, `JevCallAudit.estimatedInputTokens`, 엄격한 Choice 파서).

## Global Constraints

- 계획 1의 Global Constraints를 모두 따른다(한국어, 커밋 trailer, core 경계, `.env*` 읽기 금지, push 금지).
- **core(`src/core/**`)는 Task 0의 선행 수정·강화 외에는 수정하지 않는다.** core 공개 API(`src/core/index.ts`)만 import한다. core에 버그가 있으면 멈추고 보고한다.
- 이 계획은 Codex 사전 검토(`docs/reviews/2026-10-08-plan2a-plan-review-codex.md`, P1~P10)를 반영한 개정판이다. 각 반영 위치에 `[P#]`를 표시했다.
- 버전 고정: `prisma` / `@prisma/client` / `@prisma/adapter-mariadb` = **정확히 7.10.0**(`latest`는 Prisma 8이라 사용 금지). Nest 코어 패키지 = 12.1.2. `@typesafe-ai/sdk` = 0.6.0. Prisma 문서는 `/docs/orm/v7/` 경로만 참고.
- 모듈 형식: `jev-chat-api`는 CommonJS 유지(`package.json`에 `"type"` 없음, tsconfig `module: nodenext`). Prisma generator는 `moduleFormat = "cjs"`, 출력은 `src/generated/prisma`(git 제외).
- 시크릿: API 키·DB 비밀번호는 env로만. `TypeSafeClient`에는 `apiKey`를 설정값으로 **명시적으로** 넘긴다(SDK의 env 자동 읽기에 의존하지 않음). SDK 로그 레벨은 `warn` 이상(`debug`는 body를 마스킹하지 않음).
- SDK 재시도는 끈다(`retry: { maxRetries: 0 }`). 재시도는 `TypesafeJudge` 한 곳에서만 1회.
- 모델은 core의 `JEV_MODEL`(`jev-1.13.0`)을 요청 payload에 항상 명시한다.
- DB 문자셋 utf8mb4. JSON 컬럼은 Prisma `Json`.
- 통합 테스트는 `TEST_DATABASE_URL`(예: `mysql://root:devroot@127.0.0.1:3306/jev_chat_test`)이 있을 때만 실행하고, 없으면 skip된다. 개발 DB와 테스트 DB는 다른 database를 쓴다.

## 파일 구조

```
jev-chat/
├─ infra/
│  ├─ docker-compose.yml               개발용 MariaDB 11.8 (선택 사항)
│  └─ mariadb-init/01-test-db.sql      테스트 database 생성
└─ jev-chat-api/
   ├─ .env.example
   ├─ prisma.config.ts
   ├─ prisma/schema.prisma
   ├─ prisma/migrations/…              (prisma migrate dev로 생성)
   ├─ vitest.config.mts                (vitest.config.ts 대체)
   ├─ test/global-setup.ts             통합 테스트 DB 초기화
   └─ src/
      ├─ adapters/
      │  ├─ jev/transport.ts           JevTransport 인터페이스 + 오류 타입
      │  ├─ jev/sdk-transport.ts       TypeSafe SDK 구현 + 오류 매핑
      │  ├─ jev/limiter.ts             전역 제한기
      │  ├─ jev/typesafe-judge.ts      core Judge 구현 (재시도 1회)
      │  ├─ knowledge/pack-schema.ts   domain-pack zod 스키마
      │  ├─ knowledge/pack-loader.ts   폴더 → 검증된 DomainPack
      │  ├─ knowledge/map-knowledge.ts KnowledgeReader 구현
      │  └─ persistence/
      │     ├─ prisma.ts               PrismaClient 생성(어댑터)
      │     ├─ knowledge.repository.ts 버전 적재·활성 버전 조회
      │     └─ turn.repository.ts      세션·턴·trace 저장, ContextReader 구현
      ├─ app/
      │  ├─ config/env.schema.ts       env zod 스키마 + validate
      │  ├─ persistence.module.ts      PrismaClient·저장소 provider
      │  ├─ knowledge/snapshot.service.ts  실행 스냅샷 보관·원자 교체·single-flight reload
      │  ├─ jev.module.ts              제한기·트랜스포트·Judge provider
      │  ├─ health.controller.ts
      │  ├─ app.module.ts
      │  └─ main.ts
      └─ scripts/knowledge-import.ts   CLI: domain-pack → 새 지식 버전
```

---

### Task 0: core 선행 수정·강화 — 실패 원인(cause) 기록 [P3] + 계획 1 최종 리뷰 반영

> 계획 1 최종 리뷰(구현 터미널, 머지 가능·Critical 0)의 "곧 수정" 항목을 adapters 작성 전에 처리한다. 이 Task만 core 수정을 허용한다. 하위 항목별로 TDD + 커밋.

**Files:**
- Modify: `jev-chat-api/src/core/judge/ports.ts`, `core/index.ts`, `core/routing/router.ts`, `core/domain/policy.ts`, `core/engine/abort.ts`, `core/engine/chat-engine.ts`, `core/boundary.spec.ts`
- Test: 각 모듈의 `*.spec.ts`

**Interfaces:**
- Produces: `interface JevCallCause { source: "transport" | "limiter" | "response" | "size"; kind?: string; status?: number }`, `JevCallAudit.cause?: JevCallCause`, `export type EngineDeps`(chat-engine), `ContextReader.loadCompletedTurns`는 시그니처 유지(엔진이 abort로 감쌈)

- [x] **0-1: JevCallCause 추가 [P3]**

`ports.ts`의 `JevCallAudit` 위에 추가하고 필드를 하나 더한다:
```ts
/** 실패 원인 증거. 평가에서 외부 장애(429/529/5xx/연결)와 내부·설정 오류를 구분하는 데 쓴다. 원문 메시지·헤더·키는 담지 않는다. */
export interface JevCallCause {
  source: "transport" | "limiter" | "response" | "size";
  /** transport: rate_limited|overloaded|server|timeout|connection|client|aborted, limiter: timeout|oversized|aborted */
  kind?: string;
  status?: number;
}
```
`JevCallAudit`에 `cause?: JevCallCause;` 추가. `core/index.ts`의 judge/ports 재수출에 `JevCallCause` 추가. (타입만 추가 — typecheck로 확인)

- [x] **0-2: in_scope 부동소수점 허용오차 (실제 재현 버그)**

실패 테스트(`router.spec.ts`): `turn({ regulation: 0.05, how_to: 0.3, error: 0.05, out_of_scope: 0.6 })` → in_scope 0.4 → **clarify(scope)** 이어야 한다(현재 0.39999999999999997로 blocked).
구현(`router.ts`):
```ts
/** 확률 합의 부동소수점 오차 제거(소수 9자리 반올림) */
const round9 = (x: number) => Math.round(x * 1e9) / 1e9;
export function inScopeProbability(probs: Record<IntentId, number>): number {
  return round9(ERP_INTENTS.reduce((sum, id) => sum + (probs[id] ?? 0), 0));
}
export function needsHelpdesk(policy: Policy, probs: Record<IntentId, number>): boolean {
  return round9((probs.error ?? 0) + (probs.account_access ?? 0)) >= policy.helpdesk;
}
```
helpdesk도 같은 경계 테스트 추가(`error: 0.3, account_access: 0.2` 이외에 `0.1 + 0.2 + 0.2` 조합으로 0.5 경계).

- [x] **0-3: DEFAULT_POLICY 깊은 동결**

실패 테스트(`policy.spec.ts` 신규): `expect(Object.isFrozen(DEFAULT_POLICY.deadlines)).toBe(true)` 및 대입 시 TypeError(strict mode).
구현(`policy.ts`):
```ts
function deepFreeze<T>(o: T): Readonly<T> {
  for (const v of Object.values(o as object)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}
export const DEFAULT_POLICY: Policy = deepFreeze({ /* 기존 값 그대로 */ });
```
(스냅샷 서비스는 팩의 policy 객체를 새로 만들므로 영향 없음.)

- [x] **0-4: linkedController → AbortSignal.any (리스너 누수 제거)**

`abort.ts`의 `linkedController`를 다음으로 바꾼다:
```ts
/** 부모가 abort되면 함께 abort되는 자식. AbortSignal.any는 GC 친화적이라 수명이 긴 부모에서도 리스너가 쌓이지 않는다. */
export function linkedController(parent: AbortSignal): { signal: AbortSignal; abort: (reason?: unknown) => void } {
  const own = new AbortController();
  return { signal: AbortSignal.any([parent, own.signal]), abort: (reason?: unknown) => own.abort(reason) };
}
```
엔진의 `bController.abort()`/`bController.signal` 사용은 그대로 동작해야 한다. 테스트: 부모 abort → 자식 abort, 자식 abort → 부모는 그대로, 같은 부모로 1000번 만들어도 부모 abort 시 모두 abort.

- [x] **0-5: 기한 초과와 다른 abort 구분 + 문맥 로딩도 기한 안에서**

`chat-engine.ts`:
- A가 끝나기 전 signal이 abort된 경우의 합성 audit: `errorKind`를 `signal.reason`이 `TimeoutError`(`(signal.reason as Error)?.name === "TimeoutError"`)면 `"timeout"`, 아니면 `"aborted"`로 기록하고 `status`는 각각 `"failed"` / `"aborted"`.
- `contextReader.loadCompletedTurns(...)`를 `raceWithAbort(..., signal, () => [])`로 감싸 DB가 멈춰도 엔진 기한을 넘기지 않게 한다(abort되면 빈 문맥으로 진행하고, 이어지는 A 호출이 즉시 abort되어 error 경로로 끝난다).
- `EngineDeps`를 `export type`으로 공개하고 `core/index.ts`에 재수출.
테스트(`chat-engine.spec.ts`):
  - `AbortSignal.timeout(5)`로 A 미완료 → `jevCalls[0]`이 `{ status: "failed", errorKind: "timeout" }`.
  - 일반 `AbortController.abort()` → `{ status: "aborted", errorKind: "aborted" }`.
  - **A 성공 후 B 대기 중 기한 초과**: A는 즉시 FAQ 미확정 성공, B는 abort까지 대기 → 기한 후 `bStatus` = `failed`(전부 미완료) → route `error`(relevance_failed), 응답 시간이 기한 + 여유(100ms) 이내.
  - 멈춘 ContextReader(영원히 pending) + `AbortSignal.timeout(20)` → 엔진이 100ms 안에 `error`로 끝난다.

- [x] **0-6: 경계 검사 정규식 보강**

`boundary.spec.ts`의 `FORBIDDEN`을 다음으로 교체하고, 위반 탐지 자체 테스트를 추가한다:
```ts
const MODULES = String.raw`(@nestjs\/|@prisma\/|prisma["'\/]|socket\.io|@typesafe-ai\/)`;
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp(String.raw`\bfrom\s*["']${MODULES}`), reason: "정적 import/export from" },
  { pattern: new RegExp(String.raw`\bimport\s*\(\s*["']${MODULES}`), reason: "동적 import()" },
  { pattern: new RegExp(String.raw`\brequire\s*\(\s*["']${MODULES}`), reason: "require()" },
  { pattern: new RegExp(String.raw`\bimport\s*["']${MODULES}`), reason: "부수효과 import" },
  { pattern: /\bprocess\s*(\.|\[\s*["'])\s*env\b/, reason: "process.env" },
];
```
자체 테스트: 아래 문자열 각각이 하나 이상의 패턴에 걸려야 하고, 정상 import(`from "zod"`, `from "../domain/types"`)는 걸리지 않아야 한다.
`import x from "@nestjs/common"`, `export { y } from "@prisma/client"`, `const m = await import("socket.io")`, `require("@typesafe-ai/sdk")`, `import "prisma/config"`, `process["env"].X`, `process.env.X`.

- [x] **0-7: 이미 취소된 신호의 미처리 rejection 제거 (Codex 계획 1 최종 리뷰 L1, Major)**

실패 테스트:
- `abort.spec.ts`(신규): 이미 abort된 signal로 `raceWithAbort(Promise.reject(new Error("x")), signal, () => "cancelled")` → `"cancelled"`를 반환하고, `process.on("unhandledRejection")` 리스너가 테스트 동안 한 번도 호출되지 않는다(테스트 끝에 `await new Promise((r) => setTimeout(r, 10))` 후 확인, 리스너는 afterEach에서 제거).
- `chat-engine.spec.ts`: 이미 abort된 signal로 `handle()` 호출, Judge의 judgeTurn/judgeRelevance가 reject하는 FakeJudge → 결과 route `error`, unhandledRejection 0건, **Judge가 한 번도 호출되지 않는다**(취소가 확정된 뒤에는 외부 작업을 시작하지 않음).
구현:
```ts
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined); // 버려지는 원 Promise의 rejection을 관찰한다
    return Promise.resolve(onAbort());
  }
  // (기존 경로 그대로)
}
```
`chat-engine.ts`: 문맥 로딩 직후와 Judge 호출 직전에 `if (signal.aborted)`이면 Judge를 호출하지 않고 A 미완료(null)·B 미시작 상태로 결정 단계로 넘어간다(0-5의 원인 구분 audit 사용).

- [x] **0-8: clarify에도 헬프데스크 후처리 (L2)**

설계 결정: `clarify`는 `showHelpdesk`면 헬프데스크 안내를 붙인다(모호하거나 범위가 애매해도 오류·계정 문제일 확률이 높으면 연락처가 필요). `blocked`·`error`는 붙이지 않는다(설계 1장 부가 규칙에 명시 — 오케스트레이터가 반영).
실패 테스트(`extractive.spec.ts`): `clarify(ambiguous)` + showHelpdesk → 마지막 줄이 헬프데스크, `clarify(scope)` + showHelpdesk도 동일, showHelpdesk=false면 문구만. `chat-engine.spec.ts`: `error 0.4 + account_access 0.3 + regulation 0.3`, ambiguity 0.8 → route clarify, 텍스트 끝이 헬프데스크.
구현: `ExtractiveAnswerer`의 clarify 분기를 즉시 반환하지 않고 `body = [문구]`로 두어 공통 후처리(`if (helpdeskRequired || input.showHelpdesk)`)를 거치게 한다.

- [x] **0-9: 크기·취소 경계 테스트 보강 (L3)**

- `templates.spec.ts`: 질문이 여러 개인 64k 독립 fixture — state+최장 질문은 32k 이하로 유지하면서 전체 합만 64,000 / 64,001이 되도록 만들어 통과/초과를 각각 확인.
- `chat-engine.spec.ts`: (a) B 하나만 기한 초과(나머지는 완료) → 완료된 B의 `usage`가 jevCalls에 보존되고 bStatus `partial`, (b) A 완료 직후 abort → 결정은 A 기준으로 정상 진행. 합성 audit(`attempts: 0`)은 "미완료·미측정" 의미임을 `ports.ts` 주석에 명시.

- [x] **0-10: 확인과 커밋**

Run: `pnpm --filter jev-chat-api test && pnpm --filter jev-chat-api typecheck` → 전부 PASS
하위 항목별 커밋(예: `fix(core): in_scope 부동소수점 허용오차(계획1 최종리뷰)`, `fix(core): 이미 취소된 신호의 미처리 rejection 제거(Codex L1)`), 0-1은 `feat(core): JevCallAudit에 실패 원인(cause) 추가 (계획 2A P3 선행)`.

설계 문서 반영(오케스트레이터 담당): blocked 변형 판정은 코드 동작(`P(smalltalk) ≥ P(out_of_scope)`이면 인사 응답)을 기준으로 설계 문구를 맞춘다.

---

### Task 1: NestJS 앱 골격 + 검증된 설정 + `/api/health`

**Files:**
- Modify: `jev-chat-api/package.json`, `jev-chat-api/tsconfig.json`, `.gitignore`
- Delete: `jev-chat-api/vitest.config.ts` → Create: `jev-chat-api/vitest.config.mts`
- Create: `jev-chat-api/.env.example`, `jev-chat-api/src/app/config/env.schema.ts`, `jev-chat-api/src/app/health.controller.ts`, `jev-chat-api/src/app/app.module.ts`, `jev-chat-api/src/app/main.ts`
- Test: `jev-chat-api/src/app/config/env.schema.spec.ts`, `jev-chat-api/src/app/health.controller.spec.ts`

**Interfaces:**
- Produces: `EnvSchema`, `type Env = z.infer<typeof EnvSchema>`, `validateEnv(raw: Record<string, unknown>): Env`, `ENV = Symbol("ENV")`(설정 객체 주입 토큰), `AppModule.forRoot(env: Env)`, `HealthController` (`GET /api/health` → `{ status: "ok" }`)

- [x] **Step 1: 의존성과 설정 파일 갱신**

`jev-chat-api/package.json`의 `scripts`·`dependencies`·`devDependencies`를 다음으로 교체(기존 항목 포함):
```json
{
  "name": "jev-chat-api",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=22.12" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/app/main.js",
    "start:dev": "tsx watch src/app/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prisma": "prisma",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "knowledge:import": "tsx src/scripts/knowledge-import.ts"
  },
  "dependencies": {
    "@jev-chat/protocol": "workspace:*",
    "@nestjs/common": "12.1.2",
    "@nestjs/core": "12.1.2",
    "@nestjs/platform-express": "12.1.2",
    "@prisma/adapter-mariadb": "7.10.0",
    "@prisma/client": "7.10.0",
    "@typesafe-ai/sdk": "0.6.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "yaml": "^2.9.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@nestjs/testing": "12.1.2",
    "@swc/core": "^1.16.13",
    "@types/node": "^22.0.0",
    "dotenv": "^17.0.0",
    "prisma": "7.10.0",
    "tsx": "^4.20.0",
    "typescript": "~6.0.2",
    "unplugin-swc": "^2.0.0",
    "vitest": "^5.0.3"
  }
}
```
설치: 루트에서 `pnpm install`. (`dotenv`, `tsx`의 실제 최신 메이저가 다르면 최신 안정 버전을 쓴다.) pnpm이 `@swc/core`, `prisma`, `@prisma/engines` 등의 빌드 스크립트 승인을 요구하면 `pnpm approve-builds`로 해당 패키지만 허용한다.

`jev-chat-api/tsconfig.json`의 `compilerOptions`에 추가:
```json
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "isolatedModules": true
```

Create `jev-chat-api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts", "src/core/testing/**"]
}
```

Delete `jev-chat-api/vitest.config.ts`, Create `jev-chat-api/vitest.config.mts`:
```ts
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
```
(`fileParallelism: false` — 통합 테스트가 같은 테스트 DB를 공유하므로 파일 단위 병렬 실행을 끈다.)

Create `jev-chat-api/test/global-setup.ts` (이 Task에서는 빈 구현, Task 3에서 채운다):
```ts
export default async function setup(): Promise<void> {}
```

루트 `.gitignore`에 추가:
```
# Prisma 생성 클라이언트
jev-chat-api/src/generated/
```

- [x] **Step 2: 실패 테스트 작성**

`jev-chat-api/src/app/config/env.schema.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.schema";

const base = {
  NODE_ENV: "development",
  TYPESAFE_API_KEY: "test-key",
  DB_HOST: "127.0.0.1",
  DB_USER: "jev",
  DB_PASSWORD: "pw",
  DB_NAME: "jev_chat",
  AUTH_MODE: "dev",
  DEV_ACCESS_TOKEN: "a".repeat(32),
};

describe("validateEnv", () => {
  it("기본값을 채운다", () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.DB_PORT).toBe(3306);
    expect(env.JEV_MAX_CONCURRENT).toBe(40);
    expect(env.JEV_MAX_RPS).toBe(70);
    expect(env.JEV_MAX_TPS).toBe(80000);
    expect(env.JEV_ATTEMPT_TIMEOUT_MS).toBe(5000);
    expect(env.JEV_LIMITER_WAIT_MS).toBe(3000);
    expect(env.JEV_MAX_RETRY_WAIT_MS).toBe(2000);
    expect(env.RETENTION_DAYS).toBe(90);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(env.DOMAIN_PACK_DIR).toBe("domain-pack/hanbit-erp");
  });
  it("숫자 문자열을 숫자로 바꾼다", () => {
    expect(validateEnv({ ...base, PORT: "4000", DB_PORT: "3307" })).toMatchObject({ PORT: 4000, DB_PORT: 3307 });
  });
  it("CORS_ORIGINS는 쉼표로 나눈다", () => {
    expect(validateEnv({ ...base, CORS_ORIGINS: "http://a.test, http://b.test" }).CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });
  it("TYPESAFE_API_KEY가 없으면 실패", () => {
    const { TYPESAFE_API_KEY: _omit, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/TYPESAFE_API_KEY/);
  });
  it("AUTH_MODE=dev인데 DEV_ACCESS_TOKEN이 32자 미만이면 실패", () => {
    expect(() => validateEnv({ ...base, DEV_ACCESS_TOKEN: "short" })).toThrow(/DEV_ACCESS_TOKEN/);
  });
  it("production에서 AUTH_MODE=dev면 시작을 거부한다", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "production" })).toThrow(/AUTH_MODE=dev/);
  });
  it("오류 메시지에 비밀 값이 들어가지 않는다", () => {
    try {
      validateEnv({ ...base, DEV_ACCESS_TOKEN: "secret-short" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-short");
    }
  });
});
```

`jev-chat-api/src/app/health.controller.spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("GET /api/health → ok", async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    expect(moduleRef.get(HealthController).health()).toEqual({ status: "ok" });
  });
});
```

- [x] **Step 3: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- env.schema health`
Expected: FAIL — 모듈 없음

- [x] **Step 4: 구현**

`jev-chat-api/src/app/config/env.schema.ts`:
```ts
import { z } from "zod";

const int = (def: number) => z.coerce.number().int().positive().default(def);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: int(3000),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
    AUTH_MODE: z.enum(["dev"]).default("dev"),
    DEV_ACCESS_TOKEN: z.string().optional(),
    TYPESAFE_API_KEY: z.string().min(1),
    TYPESAFE_BASE_URL: z.url().optional(),
    JEV_ATTEMPT_TIMEOUT_MS: int(5000),
    JEV_MAX_CONCURRENT: int(40),
    JEV_MAX_RPS: int(70),
    JEV_MAX_TPS: int(80000),
    JEV_LIMITER_WAIT_MS: int(3000),
    JEV_MAX_RETRY_WAIT_MS: int(2000),
    DB_HOST: z.string().min(1),
    DB_PORT: int(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string(),
    DB_NAME: z.string().min(1),
    DB_CONNECTION_LIMIT: int(10),
    DOMAIN_PACK_DIR: z.string().default("domain-pack/hanbit-erp"),
    RETENTION_DAYS: int(90),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["AUTH_MODE"], message: "production에서는 AUTH_MODE=dev를 사용할 수 없습니다." });
    }
    if (env.AUTH_MODE === "dev" && (env.DEV_ACCESS_TOKEN ?? "").length < 32) {
      ctx.addIssue({ code: "custom", path: ["DEV_ACCESS_TOKEN"], message: "AUTH_MODE=dev에는 32자 이상의 DEV_ACCESS_TOKEN이 필요합니다." });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
export const ENV = Symbol("ENV");

/** 실패 시 경로와 메시지만 담은 오류를 던진다(입력 값은 포함하지 않음). */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`환경 변수 검증 실패\n${lines.join("\n")}`);
  }
  return parsed.data;
}
```

`jev-chat-api/src/app/health.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";

@Controller("api/health")
export class HealthController {
  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }
}
```

`jev-chat-api/src/app/app.module.ts` (이 Task의 최소 형태 — Task 4·5에서 모듈을 추가한다):
```ts
import { Module, type DynamicModule } from "@nestjs/common";
import { ENV, type Env } from "./config/env.schema";
import { HealthController } from "./health.controller";

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
```

`jev-chat-api/src/app/main.ts`:
```ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.schema";

async function bootstrap(): Promise<void> {
  const env = validateEnv(process.env);
  const app = await NestFactory.create(AppModule.forRoot(env));
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: false });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

void bootstrap();
```
※ `dotenv`는 devDependency다. 운영(PM2)에서는 계획 2B의 ecosystem 설정이 `.env`를 로드하므로, `dotenv/config` import가 실패하지 않도록 `dotenv`를 `dependencies`로 옮긴다:
`pnpm --filter jev-chat-api add dotenv` (devDependencies에서 제거됨을 확인).

`jev-chat-api/.env.example`:
```bash
# 복사해서 .env로 사용. 실제 값은 절대 커밋하지 않는다.
NODE_ENV=development
PORT=3000
CORS_ORIGINS=http://localhost:5173

# 인증 (MVP: 공유 테스트 관리자 계정, production에서는 시작 거부)
AUTH_MODE=dev
DEV_ACCESS_TOKEN=          # 32자 이상 임의 문자열 (예: openssl rand -hex 24)

# TypeSafe Jev
TYPESAFE_API_KEY=
JEV_ATTEMPT_TIMEOUT_MS=5000
JEV_MAX_CONCURRENT=40
JEV_MAX_RPS=70
JEV_MAX_TPS=80000
JEV_LIMITER_WAIT_MS=3000     # 제한기 대기 상한(서버 전역 설정, trace의 policy에도 이 값이 기록됨)
JEV_MAX_RETRY_WAIT_MS=2000   # Retry-After가 이보다 길면 재시도하지 않음

# MariaDB (앱 접속 정보, Docker 비의존)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=jev_chat
DB_CONNECTION_LIMIT=10

# Prisma CLI용 (migrate). 비워두면 DB_* 값으로 조립한다.
DATABASE_URL=

# 통합 테스트 전용 database (개발 DB와 분리)
TEST_DATABASE_URL=

DOMAIN_PACK_DIR=domain-pack/hanbit-erp
RETENTION_DAYS=90
```

- [x] **Step 5: 실행 → 통과 + 전체 회귀 확인**

Run: `pnpm --filter jev-chat-api test && pnpm --filter jev-chat-api typecheck`
Expected: core 테스트 포함 전부 PASS, Vite ESM/CJS 설정 경고가 사라짐, 타입 오류 없음

- [x] **Step 6: 커밋**

```bash
git add .gitignore pnpm-lock.yaml pnpm-workspace.yaml jev-chat-api
git commit -m "feat(api): NestJS 골격, env 검증(운영 dev 인증 거부), /api/health

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Jev 어댑터 — 전역 제한기 + 트랜스포트 + TypesafeJudge

**Files:**
- Create: `jev-chat-api/src/adapters/jev/{transport.ts,limiter.ts,sdk-transport.ts,typesafe-judge.ts}`
- Test: `jev-chat-api/src/adapters/jev/{limiter.spec.ts,sdk-transport.spec.ts,typesafe-judge.spec.ts}`

**Interfaces:**
- Consumes (core): `Judge`, `JudgeOutcome`, `JudgeErrorKind`, `JevCallAudit`, `TurnJudgeRequest`, `RelevanceRequest`, `TurnJudgment`, `JevRequest`, `buildTurnRequest`, `buildRelevanceRequest`, `parseTurnAnswers`, `parseRelevanceAnswer`, `JevResponseError`, `estimateTokens`
- Produces:
  - `interface JevTransportResult { model: string; answers: unknown; usage: { inputTokens: number; outputTokens: number } }`
  - `type JevTransportErrorKind = "rate_limited" | "overloaded" | "server" | "timeout" | "connection" | "aborted" | "client"`
  - `class JevTransportError extends Error { kind; status?: number; retryAfterMs?: number }`
  - `interface JevTransport { send(payload: JevRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<JevTransportResult> }`
  - `class SdkJevTransport implements JevTransport` — `constructor(config: { apiKey: string; baseURL?: string; fetch?: typeof fetch; logger?: SdkLogger })`
  - `interface LimiterConfig { maxConcurrent: number; maxRequestsPerSecond: number; maxTokensPerSecond: number; maxWaitMs: number }`
  - `class LimiterRejectedError extends Error`
  - `class JevLimiter` — `constructor(config: LimiterConfig, now?: () => number)`, `acquire(estimatedTokens: number, signal: AbortSignal): Promise<() => void>`, `stats(): { active: number; waiting: number }`
  - `class TypesafeJudge implements Judge` — `constructor(deps: { transport: JevTransport; limiter: JevLimiter; attemptTimeoutMs: number; maxAttempts?: number; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> })`

- [x] **Step 1: 실패 테스트 작성**

`jev-chat-api/src/adapters/jev/limiter.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { JevLimiter, LimiterRejectedError } from "./limiter";

const cfg = { maxConcurrent: 2, maxRequestsPerSecond: 100, maxTokensPerSecond: 1_000_000, maxWaitMs: 200 };
const live = () => new AbortController().signal;

describe("JevLimiter", () => {
  it("동시 실행 상한을 지킨다 — 슬롯이 반환되면 대기자가 진행", async () => {
    const limiter = new JevLimiter(cfg);
    const r1 = await limiter.acquire(10, live());
    const r2 = await limiter.acquire(10, live());
    let third = false;
    const p3 = limiter.acquire(10, live()).then((r) => {
      third = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(third).toBe(false);
    expect(limiter.stats()).toEqual({ active: 2, waiting: 1 });
    r1();
    (await p3)();
    expect(third).toBe(true);
    r2();
  });

  it("maxWaitMs를 넘기면 LimiterRejectedError", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 1, maxWaitMs: 40 });
    const r1 = await limiter.acquire(10, live());
    await expect(limiter.acquire(10, live())).rejects.toMatchObject({ reason: "timeout" });
    r1();
  });

  it("초당 요청 수를 지킨다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxRequestsPerSecond: 2, maxWaitMs: 50 });
    (await limiter.acquire(1, live()))();
    (await limiter.acquire(1, live()))();
    await expect(limiter.acquire(1, live())).rejects.toBeInstanceOf(LimiterRejectedError);
  });

  it("[P1] 첫 요청이라도 초당 토큰 예산보다 크면 즉시 oversized 거절", async () => {
    const limiter = new JevLimiter({ ...cfg, maxTokensPerSecond: 100 });
    await expect(limiter.acquire(101, live())).rejects.toMatchObject({ reason: "oversized" });
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("[P1] 예산과 정확히 같은 요청은 통과", async () => {
    const limiter = new JevLimiter({ ...cfg, maxTokensPerSecond: 100 });
    (await limiter.acquire(100, live()))();
  });

  it("[P1] 창이 만료된 직후에도 토큰 예산을 적용한다(가짜 시계)", async () => {
    let t = 0;
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxTokensPerSecond: 100, maxWaitMs: 50 }, () => t);
    (await limiter.acquire(90, live()))();
    t = 1000; // 첫 창 만료
    (await limiter.acquire(90, live()))(); // t=1000 창: 90 사용
    const p = limiter.acquire(20, live()); // 110 > 100 → 대기
    t = 1051; // 대기 기한(50ms)만 지나고 t=1000 창은 아직 유효 → timeout 거절
    await expect(p).rejects.toMatchObject({ reason: "timeout" });
  });

  it("초당 토큰 수를 지킨다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxTokensPerSecond: 100, maxWaitMs: 50 });
    (await limiter.acquire(80, live()))();
    await expect(limiter.acquire(30, live())).rejects.toBeInstanceOf(LimiterRejectedError);
  });

  it("1초 창이 지나면 다시 허용한다(가짜 시계)", async () => {
    let t = 0;
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 10, maxRequestsPerSecond: 1, maxWaitMs: 2000 }, () => t);
    (await limiter.acquire(1, live()))();
    const p = limiter.acquire(1, live());
    t = 1001;
    (await p)();
  });

  it("대기 중 abort되면 즉시 거절하고 대기열에서 빠진다", async () => {
    const limiter = new JevLimiter({ ...cfg, maxConcurrent: 1, maxWaitMs: 1000 });
    const r1 = await limiter.acquire(1, live());
    const ctrl = new AbortController();
    const p = limiter.acquire(1, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(limiter.stats().waiting).toBe(0);
    r1();
  });

  it("release를 두 번 불러도 슬롯은 한 번만 반환된다", async () => {
    const limiter = new JevLimiter(cfg);
    const r = await limiter.acquire(1, live());
    r();
    r();
    expect(limiter.stats().active).toBe(0);
  });
});
```

`jev-chat-api/src/adapters/jev/sdk-transport.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { JevTransportError } from "./transport";
import { retryAfterFrom, SdkJevTransport, toTransportError } from "./sdk-transport";
import type { JevRequest } from "../../core";

const payload: JevRequest = {
  model: "jev-1.13.0",
  state: { employee_message: "법인카드 한도" },
  questions: { relevant: { type: "noul", instructions: "Q?", criteria: { true: "t", false: "f" } } },
};

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function transport(f: typeof fetch) {
  return new SdkJevTransport({ apiKey: "test-key", baseURL: "http://jev.test", fetch: f });
}

describe("SdkJevTransport", () => {
  it("성공 응답을 도메인 결과로 바꾼다", async () => {
    const f = fakeFetch(200, { model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 4 } });
    const r = await transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(r).toEqual({ model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { inputTokens: 120, outputTokens: 4 } });
    expect(f.calls[0]?.url).toBe("http://jev.test/v1/systemone");
    const sent = JSON.parse(String(f.calls[0]?.init?.body));
    expect(sent.model).toBe("jev-1.13.0");
    expect(f.calls).toHaveLength(1); // SDK 재시도 꺼짐
  });

  it("429 → rate_limited + retryAfterMs", async () => {
    const f = fakeFetch(429, { error: "rate" }, { "retry-after-ms": "250" });
    const err = await transport(f.fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(JevTransportError);
    expect(err).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 250 });
    expect(f.calls).toHaveLength(1);
  });

  it("529 → overloaded, 500 → server, 400 → client", async () => {
    const s = new AbortController().signal;
    expect(await transport(fakeFetch(529, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("overloaded");
    expect(await transport(fakeFetch(500, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("server");
    expect(await transport(fakeFetch(400, {}).fn).send(payload, { signal: s, timeoutMs: 1000 }).catch((e) => e.kind)).toBe("client");
  });

  it("[P2] 503 + HTTP-date Retry-After → 남은 시간(ms)으로 해석", async () => {
    const future = new Date(Date.now() + 1500).toUTCString();
    const err = await transport(fakeFetch(503, {}, { "retry-after": future }).fn)
      .send(payload, { signal: new AbortController().signal, timeoutMs: 1000 })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "server", status: 503 });
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(1500);
  });

  it("[P2] retryAfterFrom: ms·초·날짜·잘못된 값·음수", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(retryAfterFrom(h({ "retry-after-ms": "250" }))).toBe(250);
    expect(retryAfterFrom(h({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterFrom(h({ "retry-after": new Date(10_000).toUTCString() }), () => 4_000)).toBe(6000);
    expect(retryAfterFrom(h({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterFrom(h({ "retry-after": "-1" }))).toBeUndefined();
    expect(retryAfterFrom(h({}))).toBeUndefined();
  });

  it("[P3] 401 → client(status 401), 재시도 대상 아님", async () => {
    const err = await transport(fakeFetch(401, { error: "bad key" }).fn).send(payload, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toMatchObject({ kind: "client", status: 401 });
  });

  it("[P3] SDK가 아닌 예외는 매핑하지 않는다(toTransportError → null)", () => {
    expect(toTransportError(new TypeError("bug"), new AbortController().signal)).toBeNull();
  });

  it("이미 abort된 signal로 호출 → aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const hanging = ((_url: string, init?: RequestInit) =>
      init?.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : new Promise(() => {})) as unknown as typeof fetch;
    expect(await transport(hanging).send(payload, { signal: ctrl.signal, timeoutMs: 5000 }).catch((e) => e.kind)).toBe("aborted");
  });

  it("호출자 abort → aborted", async () => {
    const ctrl = new AbortController();
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const p = transport(hanging).send(payload, { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    expect(await p.catch((e) => e.kind)).toBe("aborted");
  });

  it("시도 타임아웃 → timeout", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const err = await transport(hanging).send(payload, { signal: new AbortController().signal, timeoutMs: 20 }).catch((e) => e);
    expect(err.kind).toBe("timeout");
  });
});
```

`jev-chat-api/src/adapters/jev/typesafe-judge.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TypesafeJudge } from "./typesafe-judge";
import { JevLimiter } from "./limiter";
import { JevTransportError, type JevTransport, type JevTransportResult } from "./transport";
import { DEFAULT_INTENTS, type JevRequest, type Chunk } from "../../core";

const limiter = () => new JevLimiter({ maxConcurrent: 10, maxRequestsPerSecond: 100, maxTokensPerSecond: 1_000_000, maxWaitMs: 100 });
const noSleep = async () => {};
const signal = () => new AbortController().signal;

const chunk: Chunk = { id: "c1", module: "m", kind: "regulation", title: "법인카드 규정", section: "한도", text: "1회 50만 원", tags: [], updatedAt: "2026-01-01", contentHash: "h" };

class ScriptedTransport implements JevTransport {
  readonly sent: JevRequest[] = [];
  constructor(private readonly script: (JevTransportResult | JevTransportError)[]) {}
  async send(payload: JevRequest): Promise<JevTransportResult> {
    this.sent.push(payload);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof JevTransportError) throw next;
    return next;
  }
}

const turnAnswers = {
  intent: { type: "choice", choice: "regulation", confidence: 0.9, probabilities: { regulation: 0.9, how_to: 0.1, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0 } },
  ambiguous: { type: "noul", noul: 0.1 },
};
const ok = (answers: unknown): JevTransportResult => ({ model: "jev-1.13.0", answers, usage: { inputTokens: 100, outputTokens: 5 } });

function judge(transport: JevTransport) {
  return new TypesafeJudge({ transport, limiter: limiter(), attemptTimeoutMs: 1000, sleep: noSleep });
}

describe("TypesafeJudge.judgeTurn", () => {
  it("성공: 파싱된 판단과 audit", async () => {
    const t = new ScriptedTransport([ok(turnAnswers)]);
    const r = await judge(t).judgeTurn({ message: "법인카드 한도", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.intent.choice).toBe("regulation");
    expect(r.audit).toMatchObject({ call: "turn", status: "ok", attempts: 1, model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 5 } });
    expect(r.audit.estimatedInputTokens).toBeGreaterThan(0);
    expect(r.audit.answer).toEqual(turnAnswers);
    expect(t.sent[0]?.model).toBe("jev-1.13.0");
  });

  it("429/529/5xx/timeout/connection은 1회 재시도", async () => {
    for (const kind of ["rate_limited", "overloaded", "server", "timeout", "connection"] as const) {
      const t = new ScriptedTransport([new JevTransportError(kind, "x"), ok(turnAnswers)]);
      const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
      expect(r.ok, kind).toBe(true);
      expect(r.audit.attempts).toBe(2);
    }
  });

  it("두 번 실패하면 provider 실패(재시도는 1회뿐)", async () => {
    const t = new ScriptedTransport([new JevTransportError("overloaded", "529"), new JevTransportError("overloaded", "529")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(r.audit).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("client(4xx) 오류는 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([new JevTransportError("client", "400")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(t.sent).toHaveLength(1);
  });

  it("abort는 aborted로, 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([new JevTransportError("aborted", "abort")]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(r.audit.status).toBe("aborted");
  });

  it("응답 형식 오류는 invalid_response, 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([ok({ intent: { type: "noul", noul: 1 } })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "invalid_response" });
    expect(t.sent).toHaveLength(1);
  });

  it("요청이 한도를 넘으면 전송하지 않고 too_large", async () => {
    const t = new ScriptedTransport([]);
    const r = await judge(t).judgeTurn({ message: "가".repeat(40000), recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "too_large" });
    expect(t.sent).toHaveLength(0);
  });

  it("FAQ 후보가 축소돼도 실제로 보낸 후보 id로 파싱한다", async () => {
    const huge = "가".repeat(15000);
    const faqCandidates = ["f1", "f2"].map((id, i) => ({
      faq: { id, intent: "regulation" as const, summary: "s", appliesWhen: "a", answer: huge, sourceChunkId: null, variants: [] },
      bm25Rank: i + 1,
      bm25Score: 1,
    }));
    const t = new ScriptedTransport([ok({ ...turnAnswers, faq: { type: "choice", choice: "f1", confidence: 0.9, probabilities: { f1: 0.9, none: 0.1 } } })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates, intents: DEFAULT_INTENTS }, signal());
    expect(r.ok).toBe(true);
    expect(Object.keys((t.sent[0]?.questions.faq as { criteria: object }).criteria)).toEqual(["f1", "none"]);
  });

  it("[P3] 실패 audit에 원인(transport kind·status)을 남긴다", async () => {
    const t = new ScriptedTransport([new JevTransportError("client", "401", { status: 401 })]);
    const r = await judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r.audit.cause).toEqual({ source: "transport", kind: "client", status: 401 });
    const t2 = new ScriptedTransport([new JevTransportError("server", "503", { status: 503 }), new JevTransportError("server", "503", { status: 503 })]);
    const r2 = await judge(t2).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r2.audit.cause).toEqual({ source: "transport", kind: "server", status: 503 });
  });

  it("[P3] 제한기 거절은 limiter 원인으로 남는다", async () => {
    const tiny = new JevLimiter({ maxConcurrent: 10, maxRequestsPerSecond: 100, maxTokensPerSecond: 1, maxWaitMs: 100 });
    const j = new TypesafeJudge({ transport: new ScriptedTransport([]), limiter: tiny, attemptTimeoutMs: 1000, sleep: noSleep });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(r.audit.cause).toEqual({ source: "limiter", kind: "oversized" });
  });

  it("[P3] 트랜스포트가 알 수 없는 예외를 던지면 재시도 없이 그대로 전파", async () => {
    const t: JevTransport = { send: async () => { throw new TypeError("bug"); } };
    await expect(judge(t).judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal())).rejects.toThrow(TypeError);
  });

  it("[P2] Retry-After가 maxRetryWaitMs보다 길면 재시도하지 않는다", async () => {
    const t = new ScriptedTransport([Object.assign(new JevTransportError("overloaded", "529", { status: 529 }), { retryAfterMs: 5000 })]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, maxRetryWaitMs: 2000, sleep: noSleep });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(r).toMatchObject({ ok: false, errorKind: "provider" });
    expect(t.sent).toHaveLength(1);
  });

  it("[P2] 재시도 대기 중 취소되면 aborted", async () => {
    const ctrl = new AbortController();
    const t = new ScriptedTransport([new JevTransportError("server", "503", { status: 503 }), ok(turnAnswers)]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, sleep: async () => ctrl.abort() });
    const r = await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, ctrl.signal);
    expect(r).toMatchObject({ ok: false, errorKind: "aborted" });
    expect(t.sent).toHaveLength(1);
  });

  it("재시도 대기 시간은 retryAfterMs를 따른다", async () => {
    const waits: number[] = [];
    const t = new ScriptedTransport([Object.assign(new JevTransportError("rate_limited", "429"), { retryAfterMs: 300 }), ok(turnAnswers)]);
    const j = new TypesafeJudge({ transport: t, limiter: limiter(), attemptTimeoutMs: 1000, sleep: async (ms) => void waits.push(ms) });
    await j.judgeTurn({ message: "q", recentTurns: [], faqCandidates: [], intents: DEFAULT_INTENTS }, signal());
    expect(waits).toEqual([300]);
  });
});

describe("TypesafeJudge.judgeRelevance", () => {
  it("noul 값과 chunkId audit", async () => {
    const t = new ScriptedTransport([ok({ relevant: { type: "noul", noul: 0.87 } })]);
    const r = await judge(t).judgeRelevance({ message: "q", recentTurns: [], chunk }, signal());
    expect(r).toMatchObject({ ok: true, value: 0.87 });
    expect(r.audit).toMatchObject({ call: "relevance", chunkId: "c1" });
  });
});
```

- [x] **Step 2: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- adapters/jev`
Expected: FAIL — 모듈 없음

- [x] **Step 3: 트랜스포트 인터페이스 작성**

`jev-chat-api/src/adapters/jev/transport.ts`:
```ts
import type { JevRequest } from "../../core";

export interface JevTransportResult {
  model: string;
  answers: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export type JevTransportErrorKind = "rate_limited" | "overloaded" | "server" | "timeout" | "connection" | "aborted" | "client";

export class JevTransportError extends Error {
  status?: number;
  retryAfterMs?: number;
  constructor(readonly kind: JevTransportErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "JevTransportError";
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface JevTransport {
  send(payload: JevRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<JevTransportResult>;
}
```

- [x] **Step 4: SDK 트랜스포트 작성**

`jev-chat-api/src/adapters/jev/sdk-transport.ts`:
```ts
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { JevRequest } from "../../core";
import { JevTransportError, type JevTransport, type JevTransportResult } from "./transport";

export interface SdkLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** [P2] retry-after-ms(밀리초) → Retry-After(초 또는 HTTP-date) 순으로 해석. 해석 불가·음수는 undefined. */
export function retryAfterFrom(headers: Headers | undefined, now: () => number = () => Date.now()): number | undefined {
  const ms = headers?.get("retry-after-ms");
  if (ms !== null && ms !== undefined) {
    const n = Number(ms);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

/** 알려진 SDK 오류만 매핑한다. [P3] 그 외(프로그래밍 오류 등)는 null → 원래 예외를 그대로 던진다. */
export function toTransportError(err: unknown, callerSignal: AbortSignal): JevTransportError | null {
  if (err instanceof APIUserAbortError) {
    // 시도 타임아웃은 우리 쪽 AbortSignal.timeout으로 구현되므로, 호출자 신호가 살아 있으면 timeout이다.
    return callerSignal.aborted ? new JevTransportError("aborted", "호출자가 취소함") : new JevTransportError("timeout", "시도 시간 초과");
  }
  if (err instanceof APITimeoutError) return new JevTransportError("timeout", "시도 시간 초과");
  if (err instanceof APIConnectionError) return new JevTransportError("connection", "연결 실패");
  if (err instanceof RateLimitError) {
    return new JevTransportError("rate_limited", "요청 한도 초과", { status: 429, retryAfterMs: err.retryAfterMs ?? retryAfterFrom(err.headers) });
  }
  if (err instanceof InternalServerError) {
    const kind = err.status === 529 ? "overloaded" : "server";
    return new JevTransportError(kind, `서버 오류 ${err.status}`, { status: err.status, retryAfterMs: retryAfterFrom(err.headers) });
  }
  if (err instanceof APIError) {
    // 408 등 기타 상태: 5xx가 아니면 client로 본다
    const kind = err.status >= 500 ? "server" : "client";
    return new JevTransportError(kind, `요청 오류 ${err.status}`, { status: err.status, retryAfterMs: retryAfterFrom(err.headers) });
  }
  return null;
}

export class SdkJevTransport implements JevTransport {
  private readonly client: TypeSafeClient;

  constructor(config: { apiKey: string; baseURL?: string; fetch?: typeof fetch; logger?: SdkLogger }) {
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.logger ? { logger: config.logger } : {}),
      logLevel: "warn",
      retry: { maxRetries: 0 },
    });
  }

  async send(payload: JevRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<JevTransportResult> {
    // 시도 타임아웃과 호출자 취소를 하나의 신호로 합친다(SDK timeout 옵션 대신 사용 — 구분을 우리가 한다).
    const attemptSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    try {
      const res = await this.client.systemOne(
        { model: payload.model, state: payload.state as never, questions: payload.questions as never },
        { signal: attemptSignal, retry: { maxRetries: 0 } },
      );
      return {
        model: res.model,
        answers: res.answers,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      };
    } catch (err) {
      throw toTransportError(err, opts.signal) ?? err;
    }
  }
}
```
※ `state`/`questions`의 `as never`는 SDK의 `const` 제네릭 추론을 우회하기 위한 것이다. payload 형태는 core 템플릿이 보장한다. SDK 타입과 맞지 않아 컴파일 오류가 나면 `as Parameters<TypeSafeClient["systemOne"]>[0]`로 바꾼다.

- [x] **Step 5: 제한기 작성**

`jev-chat-api/src/adapters/jev/limiter.ts`:
```ts
export interface LimiterConfig {
  maxConcurrent: number;
  maxRequestsPerSecond: number;
  maxTokensPerSecond: number;
  maxWaitMs: number;
}

export type LimiterRejectReason = "timeout" | "oversized" | "aborted";

export class LimiterRejectedError extends Error {
  constructor(readonly reason: LimiterRejectReason, message = "Jev 제한기 대기 시간 초과") {
    super(message);
    this.name = "LimiterRejectedError";
  }
}

interface Waiter {
  tokens: number;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const WINDOW_MS = 1000;
const POLL_MS = 10;

/** 같은 API 키를 쓰는 모든 Jev 호출이 통과하는 단일 프로세스 제한기 (FIFO). */
export class JevLimiter {
  private active = 0;
  private readonly window: { at: number; tokens: number }[] = [];
  private readonly queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: LimiterConfig, private readonly now: () => number = () => Date.now()) {}

  stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }

  acquire(estimatedTokens: number, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new LimiterRejectedError("aborted", "이미 취소된 요청"));
    // [P1] 요청 하나가 초당 토큰 예산보다 크면 기다려도 통과할 수 없으므로 즉시 거절한다.
    if (estimatedTokens > this.config.maxTokensPerSecond) {
      return Promise.reject(new LimiterRejectedError("oversized", "요청 추정 토큰이 초당 예산보다 큼"));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.remove(waiter);
        reject(new LimiterRejectedError("aborted", "대기 중 취소됨"));
      };
      const waiter: Waiter = {
        tokens: estimatedTokens,
        enqueuedAt: this.now(),
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  private remove(waiter: Waiter): void {
    const i = this.queue.indexOf(waiter);
    if (i >= 0) this.queue.splice(i, 1);
    waiter.cleanup();
  }

  private prune(now: number): void {
    while (this.window.length > 0 && now - this.window[0]!.at >= WINDOW_MS) this.window.shift();
  }

  private canStart(tokens: number, now: number): boolean {
    this.prune(now);
    const usedTokens = this.window.reduce((s, w) => s + w.tokens, 0);
    return (
      this.active < this.config.maxConcurrent &&
      this.window.length < this.config.maxRequestsPerSecond &&
      usedTokens + tokens <= this.config.maxTokensPerSecond
    );
  }

  private pump(): void {
    const now = this.now();
    // 기한이 지난 대기자 거절
    for (const w of [...this.queue]) {
      if (now - w.enqueuedAt > this.config.maxWaitMs) {
        this.remove(w);
        w.reject(new LimiterRejectedError("timeout"));
      }
    }
    // FIFO로 시작 가능한 만큼 시작
    while (this.queue.length > 0 && this.canStart(this.queue[0]!.tokens, now)) {
      const w = this.queue.shift()!;
      w.cleanup();
      this.active++;
      this.window.push({ at: now, tokens: w.tokens });
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.queue.length === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, POLL_MS);
    this.timer.unref?.();
  }
}
```

- [x] **Step 6: TypesafeJudge 작성**

`jev-chat-api/src/adapters/jev/typesafe-judge.ts`:
```ts
import {
  buildRelevanceRequest,
  buildTurnRequest,
  estimateTokens,
  JevResponseError,
  parseRelevanceAnswer,
  parseTurnAnswers,
  type JevCallAudit,
  type JevRequest,
  type Judge,
  type JudgeErrorKind,
  type JudgeOutcome,
  type RelevanceRequest,
  type TurnJudgeRequest,
  type TurnJudgment,
} from "../../core";
import { JevLimiter, LimiterRejectedError } from "./limiter";
import { JevTransportError, type JevTransport } from "./transport";

const RETRYABLE = new Set(["rate_limited", "overloaded", "server", "timeout", "connection"]);
const DEFAULT_BACKOFF_MS = 300;

interface Deps {
  transport: JevTransport;
  limiter: JevLimiter;
  attemptTimeoutMs: number;
  /** [P2] Retry-After가 이보다 길면 재시도하지 않는다 */
  maxRetryWaitMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export class TypesafeJudge implements Judge {
  private readonly maxAttempts: number;
  private readonly maxRetryWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: Deps) {
    this.maxAttempts = deps.maxAttempts ?? 2;
    this.maxRetryWaitMs = deps.maxRetryWaitMs ?? 2000;
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? abortableSleep;
  }

  judgeTurn(req: TurnJudgeRequest, signal: AbortSignal): Promise<JudgeOutcome<TurnJudgment>> {
    const payload = buildTurnRequest(req);
    if (!payload) return Promise.resolve(this.tooLarge("turn"));
    const sentFaqIds = payload.questions.faq ? Object.keys(payload.questions.faq.criteria).filter((k) => k !== "none") : [];
    return this.call("turn", payload, (answers) => parseTurnAnswers(answers, sentFaqIds), signal);
  }

  judgeRelevance(req: RelevanceRequest, signal: AbortSignal): Promise<JudgeOutcome<number>> {
    const payload = buildRelevanceRequest(req);
    if (!payload) return Promise.resolve(this.tooLarge("relevance", req.chunk.id));
    return this.call("relevance", payload, parseRelevanceAnswer, signal, req.chunk.id);
  }

  private tooLarge<T>(call: "turn" | "relevance", chunkId?: string): JudgeOutcome<T> {
    const audit: JevCallAudit = { call, status: "failed", attempts: 0, latencyMs: 0, errorKind: "too_large", cause: { source: "size" }, ...(chunkId ? { chunkId } : {}) };
    return { ok: false, errorKind: "too_large", message: "요청 크기 한도 초과", audit };
  }

  private async call<T>(
    call: "turn" | "relevance",
    payload: JevRequest,
    parse: (answers: unknown) => T,
    signal: AbortSignal,
    chunkId?: string,
  ): Promise<JudgeOutcome<T>> {
    const started = this.now();
    const tokens = estimateTokens(payload.state) + estimateTokens(payload.questions);
    let attempts = 0;
    const fail = (errorKind: JudgeErrorKind, message: string, extra: Partial<JevCallAudit> = {}): JudgeOutcome<T> => ({
      ok: false,
      errorKind,
      message,
      audit: {
        call,
        status: errorKind === "aborted" ? "aborted" : "failed",
        attempts,
        latencyMs: this.now() - started,
        estimatedInputTokens: tokens,
        errorKind,
        ...(chunkId ? { chunkId } : {}),
        ...extra,
      },
    });

    while (attempts < this.maxAttempts) {
      if (signal.aborted) return fail("aborted", "취소됨");
      let release: () => void;
      try {
        release = await this.deps.limiter.acquire(tokens, signal);
      } catch (e) {
        if (signal.aborted) return fail("aborted", "취소됨", { cause: { source: "limiter", kind: "aborted" } });
        if (e instanceof LimiterRejectedError) return fail("provider", e.message, { cause: { source: "limiter", kind: e.reason } });
        throw e;
      }
      attempts++;
      try {
        const res = await this.deps.transport.send(payload, { signal, timeoutMs: this.deps.attemptTimeoutMs });
        release();
        try {
          const value = parse(res.answers);
          return {
            ok: true,
            value,
            audit: {
              call,
              status: "ok",
              attempts,
              latencyMs: this.now() - started,
              model: res.model,
              usage: res.usage,
              estimatedInputTokens: tokens,
              answer: res.answers,
              ...(chunkId ? { chunkId } : {}),
            },
          };
        } catch (e) {
          if (e instanceof JevResponseError) {
            return fail("invalid_response", e.message, { model: res.model, usage: res.usage, answer: res.answers, cause: { source: "response" } });
          }
          throw e;
        }
      } catch (e) {
        release();
        if (!(e instanceof JevTransportError)) throw e; // [P3] 알 수 없는 예외는 재시도하지 않고 위로 전달(내부 오류)
        const cause = { source: "transport" as const, kind: e.kind, ...(e.status !== undefined ? { status: e.status } : {}) };
        if (e.kind === "aborted") return fail("aborted", e.message, { cause });
        const wait = e.retryAfterMs ?? DEFAULT_BACKOFF_MS;
        const retryable = RETRYABLE.has(e.kind) && attempts < this.maxAttempts && wait <= this.maxRetryWaitMs;
        if (!retryable) return fail(e.kind === "timeout" ? "timeout" : "provider", e.message, { cause });
        await this.sleep(wait, signal);
        if (signal.aborted) return fail("aborted", "재시도 대기 중 취소됨", { cause });
      }
    }
    return fail("provider", "재시도 소진");
  }
}
```

- [x] **Step 7: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test && pnpm --filter jev-chat-api typecheck`
Expected: 전부 PASS, 타입 오류 없음. `sdk-transport.spec.ts`에서 SDK가 가짜 fetch를 정확히 1회 호출하는지 확인됨(재시도 꺼짐).

- [x] **Step 8: 커밋**

```bash
git add jev-chat-api pnpm-lock.yaml
git commit -m "feat(api): Jev 어댑터 - 전역 제한기, SDK 트랜스포트, 1회 재시도 TypesafeJudge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prisma 스키마 + 마이그레이션 + 개발용 MariaDB + 테스트 DB 준비

**Files:**
- Create: `infra/docker-compose.yml`, `infra/mariadb-init/01-test-db.sql`
- Create: `jev-chat-api/prisma.config.ts`, `jev-chat-api/prisma/schema.prisma`, `jev-chat-api/prisma/migrations/**`(생성됨)
- Create: `jev-chat-api/src/adapters/persistence/prisma.ts`
- Modify: `jev-chat-api/test/global-setup.ts`
- Test: `jev-chat-api/src/adapters/persistence/prisma.spec.ts`

**Interfaces:**
- Produces: `createPrismaClient(db: { host: string; port: number; user: string; password: string; database: string; connectionLimit: number }): PrismaClient`, `dbConfigFromUrl(url: string)`, `testPrisma(): PrismaClient | null`(TEST_DATABASE_URL 없으면 null), `resetTestDb(prisma: PrismaClient): Promise<void>`, 그리고 생성된 Prisma 모델: `KnowledgeVersion`, `KnowledgeChunk`, `Faq`, `FaqVariant`, `ChatSession`, `ChatTurn`, `MessageTrace`, `MessageReview`

> **사전 조건(사람):** Docker Desktop을 실행하거나, 로컬 MariaDB 11.x에 `jev_chat`, `jev_chat_test` database와 권한 있는 계정을 준비한다. 오케스트레이터가 사용자에게 요청한다. 준비되지 않으면 Step 5~7의 DB 단계에서 멈추고 보고한다.

- [x] **Step 1: 개발용 MariaDB 구성(선택 사항, Docker)**

`infra/docker-compose.yml`:
```yaml
# 개발 편의용. 앱은 Docker에 의존하지 않고 DB_* 환경 변수로만 접속한다.
services:
  mariadb:
    image: mariadb:11.8
    container_name: jev-chat-mariadb
    restart: unless-stopped
    ports:
      - "127.0.0.1:3306:3306"
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD:-devroot}
      MARIADB_DATABASE: jev_chat
      MARIADB_USER: ${MARIADB_USER:-jev}
      MARIADB_PASSWORD: ${MARIADB_PASSWORD:-jevdev}
    command: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"]
    volumes:
      - jev-chat-mariadb:/var/lib/mysql
      - ./mariadb-init:/docker-entrypoint-initdb.d:ro
volumes:
  jev-chat-mariadb:
```

`infra/mariadb-init/01-test-db.sql`:
```sql
-- 통합 테스트 전용 database (개발 DB와 분리)
CREATE DATABASE IF NOT EXISTS jev_chat_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON jev_chat_test.* TO 'jev'@'%';
-- prisma migrate dev의 shadow database 생성 권한
GRANT CREATE, DROP ON *.* TO 'jev'@'%';
FLUSH PRIVILEGES;
```

- [x] **Step 2: Prisma 설정과 스키마 작성**

`jev-chat-api/prisma.config.ts`:
```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_PORT = "3306", DB_USER, DB_PASSWORD = "", DB_NAME } = process.env;
  if (DB_HOST && DB_USER && DB_NAME) {
    return `mysql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  }
  // prisma generate처럼 DB 접속이 필요 없는 명령을 위한 자리표시자
  return "mysql://placeholder:placeholder@127.0.0.1:3306/placeholder";
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl() },
});
```

`jev-chat-api/prisma/schema.prisma`:
```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "mysql"
}

enum KnowledgeVersionStatus {
  active
  archived
  failed
}

enum ChunkKind {
  regulation
  how_to
}

enum TurnStatus {
  processing
  completed
  failed
}

enum Verdict {
  correct
  wrong
  partial
}

model KnowledgeVersion {
  id           String                 @id @default(uuid()) @db.Char(36)
  packName     String                 @map("pack_name") @db.VarChar(100)
  packVersion  String                 @map("pack_version") @db.VarChar(50)
  contentHash  String                 @map("content_hash") @db.Char(64)
  status       KnowledgeVersionStatus
  packSnapshot Json                   @map("pack_snapshot")
  createdAt    DateTime               @default(now()) @map("created_at") @db.DateTime(3)
  chunks       KnowledgeChunk[]
  faqs         Faq[]

  @@index([status, createdAt])
  @@map("knowledge_versions")
}

/// [P7] 활성 지식 버전 포인터(단일 행 id=1). import는 이 행을 FOR UPDATE로 잠가 직렬화한다.
model KnowledgeState {
  id              Int     @id
  activeVersionId String? @map("active_version_id") @db.Char(36)

  @@map("knowledge_state")
}

model KnowledgeChunk {
  versionId   String           @map("version_id") @db.Char(36)
  id          String           @db.VarChar(100)
  module      String           @db.VarChar(100)
  kind        ChunkKind
  title       String           @db.VarChar(200)
  section     String           @db.VarChar(200)
  text        String           @db.Text
  tags        Json
  updatedAt   String           @map("updated_at") @db.VarChar(10)
  contentHash String           @map("content_hash") @db.Char(64)
  version     KnowledgeVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)
  faqs        Faq[]

  @@id([versionId, id])
  @@map("knowledge_chunks")
}

model Faq {
  versionId     String           @map("version_id") @db.Char(36)
  id            String           @db.VarChar(100)
  intent        String           @db.VarChar(30)
  summary       String           @db.VarChar(500)
  appliesWhen   String           @map("applies_when") @db.Text
  answer        String           @db.Text
  sourceChunkId String?          @map("source_chunk_id") @db.VarChar(100)
  version       KnowledgeVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)
  sourceChunk   KnowledgeChunk?  @relation(fields: [versionId, sourceChunkId], references: [versionId, id], onDelete: Restrict, onUpdate: Restrict)
  variants      FaqVariant[]

  @@id([versionId, id])
  @@map("faqs")
}

model FaqVariant {
  id        Int    @id @default(autoincrement())
  versionId String @map("version_id") @db.Char(36)
  faqId     String @map("faq_id") @db.VarChar(100)
  text      String @db.VarChar(1000)
  faq       Faq    @relation(fields: [versionId, faqId], references: [versionId, id], onDelete: Cascade)

  @@index([versionId, faqId])
  @@map("faq_variants")
}

model ChatSession {
  id           String     @id @db.Char(36)
  userId       String     @map("user_id") @db.VarChar(100)
  channel      String     @db.VarChar(50)
  nextTurnSeq  Int        @default(1) @map("next_turn_seq")
  createdAt    DateTime   @default(now()) @map("created_at") @db.DateTime(3)
  lastActiveAt DateTime   @default(now()) @map("last_active_at") @db.DateTime(3)
  turns        ChatTurn[]

  @@index([userId, lastActiveAt])
  @@map("chat_sessions")
}

model ChatTurn {
  id             String        @id @default(uuid()) @db.Char(36)
  sessionId      String        @map("session_id") @db.Char(36)
  turnSeq        Int           @map("turn_seq")
  clientMsgId    String        @map("client_msg_id") @db.Char(36)
  userText       String        @map("user_text") @db.Text
  retryOfTurnSeq Int?          @map("retry_of_turn_seq")
  status         TurnStatus
  errorCode      String?       @map("error_code") @db.VarChar(40)
  errorRetryable Boolean?      @map("error_retryable")
  assistantText  String?       @map("assistant_text") @db.Text
  route          String?       @db.VarChar(20)
  sources        Json?
  createdAt      DateTime      @default(now()) @map("created_at") @db.DateTime(3)
  completedAt    DateTime?     @map("completed_at") @db.DateTime(3)
  session        ChatSession   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  trace          MessageTrace?

  @@unique([sessionId, turnSeq])
  @@unique([sessionId, clientMsgId])
  @@index([status])
  @@index([createdAt])
  @@map("chat_turns")
}

model MessageTrace {
  id                 String          @id @default(uuid()) @db.Char(36)
  turnId             String          @unique @map("turn_id") @db.Char(36)
  knowledgeVersionId String          @map("knowledge_version_id") @db.Char(36)
  templateVersion    String          @map("template_version") @db.VarChar(20)
  modelVersion       String?         @map("model_version") @db.VarChar(40)
  route              String          @db.VarChar(20)
  intent             String?         @db.VarChar(30)
  inScope            Float?          @map("in_scope")
  ambiguity          Float?
  faqChoice          String?         @map("faq_choice") @db.VarChar(100)
  faqProb            Float?          @map("faq_prob")
  faqConfidence      Float?          @map("faq_confidence")
  bStatus            String          @map("b_status") @db.VarChar(20)
  totalInputTokens   Int             @map("total_input_tokens")
  errorCode          String?         @map("error_code") @db.VarChar(40)
  data               Json
  createdAt          DateTime        @default(now()) @map("created_at") @db.DateTime(3)
  turn               ChatTurn        @relation(fields: [turnId], references: [id], onDelete: Cascade)
  reviews            MessageReview[]

  @@index([route, createdAt])
  @@map("message_traces")
}

model MessageReview {
  id               String       @id @default(uuid()) @db.Char(36)
  traceId          String       @map("trace_id") @db.Char(36)
  verdict          Verdict
  expectedIntent   String?      @map("expected_intent") @db.VarChar(30)
  expectedFaqId    String?      @map("expected_faq_id") @db.VarChar(100)
  expectedChunkIds Json?        @map("expected_chunk_ids")
  note             String?      @db.Text
  reviewerId       String       @map("reviewer_id") @db.VarChar(100)
  createdAt        DateTime     @default(now()) @map("created_at") @db.DateTime(3)
  trace            MessageTrace @relation(fields: [traceId], references: [id], onDelete: Cascade)

  @@map("message_reviews")
}
```
※ 설계 3장의 trace 상세 필드(intent_probs, context, retrieval, candidates, jev_calls, latency_ms, policy)는 core `TraceRecord` 전체를 `data` JSON 하나로 저장하고, 조회·필터에 쓰는 값만 컬럼으로 뺀다(설계 대비 저장 형식 단순화, 정보 손실 없음).

- [x] **Step 3: 스키마 검증과 클라이언트 생성 확인** [P6]

Run: `pnpm --filter jev-chat-api prisma validate && pnpm --filter jev-chat-api db:generate`
Expected: 오류 없음, `jev-chat-api/src/generated/prisma/client.ts` 등 생성.
- 만약 `Faq.sourceChunk`(필수 `versionId` + 선택 `sourceChunkId`의 복합 관계)에서 Prisma 7.10이 "relation must be required" 류의 검증 오류를 내면: `sourceChunk` 관계와 `KnowledgeChunk.faqs` 역관계를 제거하고, 그 자리에 주석 `// 설계 예외: source_chunk_id 무결성은 loadDomainPack 검증 + KnowledgeRepository 적재 트랜잭션에서 보장`을 남긴 뒤 다시 validate한다. 어느 쪽을 택했는지 커밋 메시지와 체크포인트 보고에 적는다.
- 마이그레이션 SQL(Step 6 이후)에서 `faqs`의 FK가 `ON DELETE RESTRICT`이고 `version_id`를 NULL로 만드는 동작(SET NULL)이 없는지 확인한다.

- [x] **Step 4: Prisma 클라이언트 팩토리와 테스트 헬퍼 작성**

`jev-chat-api/src/adapters/persistence/prisma.ts`:
```ts
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
}

export function createPrismaClient(db: DbConfig): PrismaClient {
  const adapter = new PrismaMariaDb({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    connectTimeout: 5000,
  });
  return new PrismaClient({ adapter });
}

export function dbConfigFromUrl(url: string, connectionLimit = 5): DbConfig {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectionLimit,
  };
}

/** 통합 테스트용. TEST_DATABASE_URL이 없으면 null(테스트 skip). */
export function testPrisma(): PrismaClient | null {
  const url = process.env.TEST_DATABASE_URL;
  return url ? createPrismaClient(dbConfigFromUrl(url)) : null;
}

/** FK 순서대로 모든 테이블을 비운다. 테스트 DB에서만 사용. */
export async function resetTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.messageReview.deleteMany();
  await prisma.messageTrace.deleteMany();
  await prisma.chatTurn.deleteMany();
  await prisma.chatSession.deleteMany();
  await prisma.faqVariant.deleteMany();
  await prisma.faq.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeVersion.deleteMany();
  await prisma.knowledgeState.deleteMany();
}
```

`jev-chat-api/test/global-setup.ts` 교체:
```ts
import { execSync } from "node:child_process";

/** TEST_DATABASE_URL이 있으면 테스트 DB에 마이그레이션을 적용한다. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  if (!/_test(\?|$)/.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL의 database 이름은 _test로 끝나야 합니다(개발 DB 보호).");
  }
  execSync("pnpm prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
```

- [x] **Step 5: 실패 테스트 작성(통합, DB 필요)**

`jev-chat-api/src/adapters/persistence/prisma.spec.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dbConfigFromUrl, resetTestDb, testPrisma } from "./prisma";

describe("dbConfigFromUrl", () => {
  it("URL을 어댑터 옵션으로 바꾼다(인코딩된 비밀번호 포함)", () => {
    expect(dbConfigFromUrl("mysql://jev:p%40ss@db.local:3307/jev_chat_test")).toEqual({
      host: "db.local", port: 3307, user: "jev", password: "p@ss", database: "jev_chat_test", connectionLimit: 5,
    });
  });
});

const prisma = testPrisma();

describe.runIf(prisma)("Prisma 스키마 (통합)", () => {
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("세션 안에서 turn_seq와 client_msg_id는 유일하다", async () => {
    await prisma!.chatSession.create({ data: { id: "00000000-0000-4000-8000-000000000001", userId: "u", channel: "test" } });
    const base = { sessionId: "00000000-0000-4000-8000-000000000001", userText: "q", status: "processing" as const };
    await prisma!.chatTurn.create({ data: { ...base, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a1" } });
    await expect(prisma!.chatTurn.create({ data: { ...base, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a2" } })).rejects.toThrow();
    await expect(prisma!.chatTurn.create({ data: { ...base, turnSeq: 2, clientMsgId: "00000000-0000-4000-8000-0000000000a1" } })).rejects.toThrow();
  });

  it("한국어와 이모지를 그대로 저장한다(utf8mb4)", async () => {
    await prisma!.chatSession.create({ data: { id: "00000000-0000-4000-8000-000000000002", userId: "u", channel: "test" } });
    const t = await prisma!.chatTurn.create({
      data: { sessionId: "00000000-0000-4000-8000-000000000002", turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000b1", userText: "연차 이월 되나요? 😀", status: "processing" },
    });
    expect((await prisma!.chatTurn.findUnique({ where: { id: t.id } }))?.userText).toBe("연차 이월 되나요? 😀");
  });
});
```

- [ ] **Step 6: 마이그레이션 생성 (사람이 준비한 DB 필요)**

`jev-chat-api/.env`가 없으면 사용자에게 `.env.example`을 복사해 DB_* 값을 채워 달라고 요청하고 멈춘다(에이전트는 `.env`를 읽거나 쓰지 않는다).
Run: `pnpm --filter jev-chat-api db:migrate --name init`
Expected: `prisma/migrations/<timestamp>_init/migration.sql` 생성, 개발 DB에 적용

- [ ] **Step 7: 통합 테스트 실행**

Run: `TEST_DATABASE_URL=<사용자가 알려준 테스트 DB URL> pnpm --filter jev-chat-api test -- persistence/prisma`
Expected: PASS 3 (TEST_DATABASE_URL 없이 실행하면 통합 2건은 skip, URL 단위 테스트 1건만 PASS)

- [ ] **Step 8: 커밋**

```bash
git add infra jev-chat-api/prisma.config.ts jev-chat-api/prisma jev-chat-api/src/adapters/persistence jev-chat-api/test pnpm-lock.yaml
git commit -m "feat(api): Prisma 7 스키마·마이그레이션, 개발용 MariaDB 구성, 테스트 DB 준비

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: domain-pack 스키마·로더 + 지식 저장소 + import CLI

**Files:**
- Create: `jev-chat-api/src/adapters/knowledge/{pack-schema.ts,pack-loader.ts,map-knowledge.ts}`
- Create: `jev-chat-api/src/adapters/persistence/knowledge.repository.ts`
- Create: `jev-chat-api/src/scripts/knowledge-import.ts`
- Create: `jev-chat-api/src/adapters/knowledge/__fixtures__/mini-pack/{manifest.yaml,policy.yaml,intents.yaml,chunks.jsonl,faqs.jsonl}`
- Test: `jev-chat-api/src/adapters/knowledge/pack-loader.spec.ts`, `jev-chat-api/src/adapters/persistence/knowledge.repository.spec.ts`

**Interfaces:**
- Consumes (core): `Chunk`, `Faq`, `IntentDef`, `Helpdesk`, `Policy`, `INTENT_IDS`, `TEMPLATE_VERSION`, `KnowledgeReader`
- Produces:
  - `interface DomainPack { manifest: { name: string; version: string; language: string; helpdesk: Helpdesk; templateVersion: string }; policy: Policy; intents: IntentDef[]; chunks: Chunk[]; faqs: Faq[]; contentHash: string }`
  - `class PackValidationError extends Error { issues: string[] }`
  - `loadDomainPack(dir: string): Promise<DomainPack>` (검증: zod 형식, 중복 ID, FAQ source_chunk 참조, intents = INTENT_IDS 정확히 6개, template_version = core TEMPLATE_VERSION)
  - `class MapKnowledgeReader implements KnowledgeReader` — `constructor(versionId: string, chunks: Chunk[], faqs: Faq[])`
  - `interface ActiveKnowledge { versionId: string; pack: Omit<DomainPack, "chunks" | "faqs" | "contentHash">; chunks: Chunk[]; faqs: Faq[] }`
  - `class KnowledgeRepository` — `constructor(prisma: PrismaClient)`, `importPack(pack: DomainPack): Promise<{ versionId: string; skipped: boolean }>` (knowledge_state 행 잠금으로 직렬화, 잠금 안에서 같은 contentHash면 skipped, 실패 시 전체 롤백), `loadActive(): Promise<ActiveKnowledge | null>` (knowledge_state 포인터 기준)

- [ ] **Step 1: 테스트용 미니 팩 작성**

`jev-chat-api/src/adapters/knowledge/__fixtures__/mini-pack/manifest.yaml`:
```yaml
name: mini-test
version: 0.0.1
language: ko
template_version: v1
helpdesk:
  phone: 02-000-0000
  email: help@hanbit.example
```

`.../mini-pack/policy.yaml`:
```yaml
in_scope: { block: 0.4, clarify: 0.6 }
ambiguous: 0.7
faq: 0.8
relevance: { reference: 0.5, answer: 0.8 }
helpdesk: 0.5
candidates: { faq: 5, chunk: 8 }
context: { max_turns: 2, assistant_max_chars: 300 }
deadlines: { engine_ms: 8000, queue_ms: 10000, save_ms: 3000 }
```

`.../mini-pack/intents.yaml`:
```yaml
- id: regulation
  description: "Asks about company rules/policies enforced through ERP (approval lines, closing deadlines, expense limits, password policy). Not how to click something."
- id: how_to
  description: "Asks how to perform a task or find a screen/menu/function in the ERP."
- id: error
  description: "Reports an ERP error message, malfunction, or unexpected behavior."
- id: account_access
  description: "Requests or has a problem with their own account, login, password reset, or permission. Questions about what the password/permission policy is are regulation."
- id: smalltalk
  description: "Greetings, thanks, or chit-chat with no ERP request."
- id: out_of_scope
  description: "A work or personal question unrelated to the ERP."
```

`.../mini-pack/chunks.jsonl`:
```
{"id":"card-001","module":"경비·법인카드","kind":"regulation","title":"법인카드 규정","section":"제3조 사용 한도","text":"법인카드 1회 사용 한도는 50만 원이다. 50만 원을 넘는 결제는 사전 품의가 필요하다.","tags":["법인카드","한도"],"updated_at":"2026-01-02"}
{"id":"card-002","module":"경비·법인카드","kind":"regulation","title":"법인카드 규정","section":"제5조 회식비","text":"회식비는 1인당 5만 원 이내로 사용한다. 단, 본부장 승인 시 1인당 7만 원까지 허용한다.","tags":["회식비"],"updated_at":"2026-01-02"}
```

`.../mini-pack/faqs.jsonl`:
```
{"id":"faq-card-limit","intent":"regulation","summary":"법인카드 1회 사용 한도","applies_when":"법인카드 한 번 결제 한도를 묻는 경우. 회식비 1인당 기준은 해당하지 않음.","answer":"법인카드 1회 사용 한도는 50만 원입니다. 초과 결제는 사전 품의가 필요합니다.","source_chunk_id":"card-001","variants":["법인카드 한도 얼마예요?","카드 한 번에 얼마까지 써요"]}
```

- [ ] **Step 2: 실패 테스트 작성**

`jev-chat-api/src/adapters/knowledge/pack-loader.spec.ts`:
```ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack, PackValidationError } from "./pack-loader";

const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

function copyMini(): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync(MINI, dir, { recursive: true });
  return dir;
}

describe("loadDomainPack", () => {
  it("미니 팩을 도메인 타입으로 읽는다", async () => {
    const pack = await loadDomainPack(MINI);
    expect(pack.manifest).toMatchObject({ name: "mini-test", version: "0.0.1", templateVersion: "v1", helpdesk: { phone: "02-000-0000" } });
    expect(pack.policy.inScope).toEqual({ block: 0.4, clarify: 0.6 });
    expect(pack.policy.context).toEqual({ maxTurns: 2, assistantMaxChars: 300 });
    expect(pack.intents.map((i) => i.id)).toEqual(["regulation", "how_to", "error", "account_access", "smalltalk", "out_of_scope"]);
    expect(pack.chunks).toHaveLength(2);
    expect(pack.chunks[0]).toMatchObject({ id: "card-001", kind: "regulation", updatedAt: "2026-01-02" });
    expect(pack.chunks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.faqs[0]).toMatchObject({ id: "faq-card-limit", sourceChunkId: "card-001", appliesWhen: expect.any(String) });
    expect(pack.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("내용이 같으면 contentHash가 같고, 바뀌면 달라진다", async () => {
    const a = await loadDomainPack(MINI);
    const dir = copyMini();
    expect((await loadDomainPack(dir)).contentHash).toBe(a.contentHash);
    const p = join(dir, "chunks.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace("50만 원이다", "60만 원이다"));
    expect((await loadDomainPack(dir)).contentHash).not.toBe(a.contentHash);
  });

  it("FAQ source_chunk_id가 없는 청크를 가리키면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"card-001"', '"card-999"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/card-999/);
  });

  it("청크 ID 중복을 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "chunks.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"card-002"', '"card-001"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/중복/);
  });

  it("intents가 정확히 6개 의도가 아니면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "intents.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("id: smalltalk", "id: weather"));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("template_version이 코드와 다르면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "manifest.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("template_version: v1", "template_version: v9"));
    await expect(loadDomainPack(dir)).rejects.toThrow(/template_version/);
  });

  it("[P8] FAQ id 'none'은 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"faq-card-limit"', '"none"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/none/);
  });

  it("[P8] 빈 source_chunk_id는 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"source_chunk_id":"card-001"', '"source_chunk_id":""'));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("[P8] 문맥 상한(max_turns ≤ 3)과 DB 길이(module ≤ 100) 검증", async () => {
    const dir = copyMini();
    const pp = join(dir, "policy.yaml");
    writeFileSync(pp, readFileSync(pp, "utf8").replace("max_turns: 2", "max_turns: 9"));
    await expect(loadDomainPack(dir)).rejects.toThrow(/max_turns/);
    const dir2 = copyMini();
    const cp = join(dir2, "chunks.jsonl");
    writeFileSync(cp, readFileSync(cp, "utf8").replace('"module":"경비·법인카드"', `"module":"${"가".repeat(101)}"`));
    await expect(loadDomainPack(dir2)).rejects.toThrow(/module/);
  });

  it("[P10] policy에 limiter_ms가 있으면 거부(서버 설정 항목)", async () => {
    const dir = copyMini();
    const pp = join(dir, "policy.yaml");
    writeFileSync(pp, readFileSync(pp, "utf8").replace("save_ms: 3000", "save_ms: 3000, limiter_ms: 3000"));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("jsonl 형식 오류는 파일명과 줄 번호를 알려준다", async () => {
    const dir = copyMini();
    writeFileSync(join(dir, "chunks.jsonl"), '{"id":"x"}\n{broken\n');
    await expect(loadDomainPack(dir)).rejects.toThrow(/chunks\.jsonl:1|chunks\.jsonl:2/);
  });
});
```

`jev-chat-api/src/adapters/persistence/knowledge.repository.spec.ts`:
```ts
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadDomainPack } from "../knowledge/pack-loader";
import { KnowledgeRepository } from "./knowledge.repository";
import { resetTestDb, testPrisma } from "./prisma";

const prisma = testPrisma();
const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

describe.runIf(prisma)("KnowledgeRepository (통합)", () => {
  const repo = new KnowledgeRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("팩을 새 버전으로 적재하고 active로 만든다", async () => {
    const pack = await loadDomainPack(MINI);
    const { versionId, skipped } = await repo.importPack(pack);
    expect(skipped).toBe(false);
    const active = await repo.loadActive();
    expect(active?.versionId).toBe(versionId);
    expect(active?.chunks.map((c) => c.id).sort()).toEqual(["card-001", "card-002"]);
    expect(active?.faqs[0]).toMatchObject({ id: "faq-card-limit", variants: ["법인카드 한도 얼마예요?", "카드 한 번에 얼마까지 써요"] });
    expect(active?.pack.policy.faq).toBe(0.8);
    expect(active?.pack.manifest.helpdesk.email).toBe("help@hanbit.example");
  });

  it("같은 내용을 다시 import하면 건너뛴다", async () => {
    const pack = await loadDomainPack(MINI);
    const first = await repo.importPack(pack);
    const second = await repo.importPack(pack);
    expect(second).toEqual({ versionId: first.versionId, skipped: true });
  });

  it("새 버전을 적재하면 이전 active는 archived가 되고 데이터는 보존된다", async () => {
    const pack = await loadDomainPack(MINI);
    const v1 = await repo.importPack(pack);
    const v2 = await repo.importPack({ ...pack, contentHash: "f".repeat(64) });
    expect((await repo.loadActive())?.versionId).toBe(v2.versionId);
    const old = await prisma!.knowledgeVersion.findUnique({ where: { id: v1.versionId } });
    expect(old?.status).toBe("archived");
    expect((await prisma!.knowledgeState.findUnique({ where: { id: 1 } }))?.activeVersionId).toBe(v2.versionId);
    expect(await prisma!.knowledgeChunk.count({ where: { versionId: v1.versionId } })).toBe(2);
  });

  it("active가 없으면 null", async () => {
    expect(await repo.loadActive()).toBeNull();
  });

  it("[P7] 같은 팩을 동시에 import하면 한 번만 적재된다", async () => {
    const pack = await loadDomainPack(MINI);
    const results = await Promise.all([repo.importPack(pack), repo.importPack(pack), repo.importPack(pack)]);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    expect(await prisma!.knowledgeVersion.count()).toBe(1);
  });

  it("[P7] 적재 중 실패하면 전체 롤백 — 기존 active와 버전 수 유지, failed 행 없음", async () => {
    const pack = await loadDomainPack(MINI);
    const v1 = await repo.importPack(pack);
    // 로더를 우회해 DB 제약(VARCHAR(1000))을 넘는 변형 문장을 넣는다
    const broken = { ...pack, contentHash: "e".repeat(64), faqs: pack.faqs.map((f) => ({ ...f, variants: ["가".repeat(1001)] })) };
    await expect(repo.importPack(broken)).rejects.toThrow();
    expect((await repo.loadActive())?.versionId).toBe(v1.versionId);
    expect(await prisma!.knowledgeVersion.count()).toBe(1);
  });
});
```

- [ ] **Step 3: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- knowledge`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 팩 스키마 작성**

`jev-chat-api/src/adapters/knowledge/pack-schema.ts`:
```ts
import { z } from "zod";
import { INTENT_IDS } from "../../core";

const Prob = z.number().min(0).max(1);
const PosInt = z.number().int().positive();

// 문자열 길이는 UTF-16 코드 단위(String.length) 기준이며 DB 컬럼 길이와 맞춘다. [P8]
export const ManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  language: z.string().min(2),
  template_version: z.string().min(1),
  helpdesk: z.object({ phone: z.string().min(1), email: z.string().min(1), url: z.string().optional() }),
});

export const PolicySchema = z.object({
  in_scope: z.object({ block: Prob, clarify: Prob }).refine((v) => v.block <= v.clarify, "in_scope.block ≤ in_scope.clarify"),
  ambiguous: Prob,
  faq: Prob,
  relevance: z.object({ reference: Prob, answer: Prob }).refine((v) => v.reference <= v.answer, "relevance.reference ≤ relevance.answer"),
  helpdesk: Prob,
  candidates: z.object({ faq: PosInt.max(10), chunk: PosInt.max(12) }),
  // [P8] 대화 문맥은 축소하지 않으므로 안전한 상한을 둔다
  context: z.object({ max_turns: PosInt.max(3), assistant_max_chars: PosInt.max(500) }),
  // [P10] 제한기 대기(limiter_ms)는 서버 설정(JEV_LIMITER_WAIT_MS)이라 팩에 두지 않는다
  deadlines: z.object({ engine_ms: PosInt, queue_ms: PosInt, save_ms: PosInt.min(1000, "save_ms는 1000 이상(트랜잭션 대기+실행 분할 하한)") }).strict(),
});

export const IntentsSchema = z
  .array(z.object({ id: z.enum(INTENT_IDS), description: z.string().min(1) }))
  .refine((arr) => arr.length === INTENT_IDS.length && INTENT_IDS.every((id) => arr.some((a) => a.id === id)), {
    message: `intents는 ${INTENT_IDS.join(", ")} 6개를 정확히 한 번씩 포함해야 합니다.`,
  });

export const ChunkLineSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "id는 소문자·숫자·하이픈"),
  module: z.string().min(1).max(100),
  kind: z.enum(["regulation", "how_to"]),
  title: z.string().min(1).max(200),
  section: z.string().min(1).max(200),
  text: z.string().min(1).max(4000, "청크 본문은 4000자 이하(대화 문맥을 줄이지 않기 위한 상한)"),
  tags: z.array(z.string()).default([]),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const FaqLineSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
    .refine((id) => id !== "none", "FAQ id 'none'은 Jev 선택지 '정답 없음'으로 예약됨"),
  intent: z.enum(INTENT_IDS),
  summary: z.string().min(1).max(500),
  applies_when: z.string().min(1).max(1000),
  answer: z.string().min(1).max(2000),
  source_chunk_id: z.string().min(1).nullable().default(null),
  variants: z.array(z.string().min(1).max(1000)).min(1),
});
```

- [ ] **Step 5: 로더와 KnowledgeReader 작성**

`jev-chat-api/src/adapters/knowledge/pack-loader.ts`:
```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { TEMPLATE_VERSION, type Chunk, type Faq, type Helpdesk, type IntentDef, type Policy } from "../../core";
import { ChunkLineSchema, FaqLineSchema, IntentsSchema, ManifestSchema, PolicySchema } from "./pack-schema";

export interface DomainPack {
  manifest: { name: string; version: string; language: string; helpdesk: Helpdesk; templateVersion: string };
  policy: Policy;
  intents: IntentDef[];
  chunks: Chunk[];
  faqs: Faq[];
  contentHash: string;
}

export class PackValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`domain-pack 검증 실패\n${issues.join("\n")}`);
    this.name = "PackValidationError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function zodIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}${i.path.length ? ` [${i.path.join(".")}]` : ""}: ${i.message}`);
}

async function readYaml<T>(dir: string, file: string, schema: z.ZodType<T>, issues: string[]): Promise<T | null> {
  const raw = parseYaml(await readFile(join(dir, file), "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    issues.push(...zodIssues(file, parsed.error));
    return null;
  }
  return parsed.data;
}

async function readJsonl<T>(dir: string, file: string, schema: z.ZodType<T>, issues: string[]): Promise<T[]> {
  const lines = (await readFile(join(dir, file), "utf8")).split("\n");
  const out: T[] = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const where = `${file}:${idx + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      issues.push(`${where}: JSON 형식 오류`);
      return;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
    else issues.push(...zodIssues(where, parsed.error));
  });
  return out;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
}

export async function loadDomainPack(dir: string): Promise<DomainPack> {
  const issues: string[] = [];
  const manifest = await readYaml(dir, "manifest.yaml", ManifestSchema, issues);
  const policy = await readYaml(dir, "policy.yaml", PolicySchema, issues);
  const intents = await readYaml(dir, "intents.yaml", IntentsSchema, issues);
  const chunkLines = await readJsonl(dir, "chunks.jsonl", ChunkLineSchema, issues);
  const faqLines = await readJsonl(dir, "faqs.jsonl", FaqLineSchema, issues);

  if (manifest && manifest.template_version !== TEMPLATE_VERSION) {
    issues.push(`manifest.yaml: template_version ${manifest.template_version}이 코드의 ${TEMPLATE_VERSION}와 다릅니다.`);
  }
  for (const id of duplicates(chunkLines.map((c) => c.id))) issues.push(`chunks.jsonl: 중복 ID ${id}`);
  for (const id of duplicates(faqLines.map((f) => f.id))) issues.push(`faqs.jsonl: 중복 ID ${id}`);
  const chunkIds = new Set(chunkLines.map((c) => c.id));
  for (const f of faqLines) {
    if (f.source_chunk_id && !chunkIds.has(f.source_chunk_id)) issues.push(`faqs.jsonl: ${f.id}의 source_chunk_id ${f.source_chunk_id}가 없습니다.`);
  }
  if (issues.length > 0 || !manifest || !policy || !intents) throw new PackValidationError(issues);

  const chunks: Chunk[] = chunkLines.map((c) => ({
    id: c.id,
    module: c.module,
    kind: c.kind,
    title: c.title,
    section: c.section,
    text: c.text,
    tags: c.tags,
    updatedAt: c.updated_at,
    contentHash: sha256(JSON.stringify([c.title, c.section, c.text, c.kind])),
  }));
  const faqs: Faq[] = faqLines.map((f) => ({
    id: f.id,
    intent: f.intent,
    summary: f.summary,
    appliesWhen: f.applies_when,
    answer: f.answer,
    sourceChunkId: f.source_chunk_id,
    variants: f.variants,
  }));
  const packManifest = {
    name: manifest.name,
    version: manifest.version,
    language: manifest.language,
    helpdesk: manifest.helpdesk.url ? manifest.helpdesk : { phone: manifest.helpdesk.phone, email: manifest.helpdesk.email },
    templateVersion: manifest.template_version,
  };
  const packPolicy: Policy = {
    inScope: policy.in_scope,
    ambiguous: policy.ambiguous,
    faq: policy.faq,
    relevance: policy.relevance,
    helpdesk: policy.helpdesk,
    candidates: policy.candidates,
    context: { maxTurns: policy.context.max_turns, assistantMaxChars: policy.context.assistant_max_chars },
    deadlines: {
      engineMs: policy.deadlines.engine_ms,
      queueMs: policy.deadlines.queue_ms,
      limiterMs: 0, // [P10] 서버 설정값으로 SnapshotService가 채운다
      saveMs: policy.deadlines.save_ms,
    },
  };
  const contentHash = sha256(JSON.stringify({ manifest: packManifest, policy: packPolicy, intents, chunks, faqs }));
  return { manifest: packManifest, policy: packPolicy, intents, chunks, faqs, contentHash };
}
```

`jev-chat-api/src/adapters/knowledge/map-knowledge.ts`:
```ts
import type { Chunk, Faq, KnowledgeReader } from "../../core";

export class MapKnowledgeReader implements KnowledgeReader {
  private readonly chunks: Map<string, Chunk>;
  private readonly faqs: Map<string, Faq>;
  constructor(readonly versionId: string, chunks: Chunk[], faqs: Faq[]) {
    this.chunks = new Map(chunks.map((c) => [c.id, c]));
    this.faqs = new Map(faqs.map((f) => [f.id, f]));
  }
  getChunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }
  getFaq(id: string): Faq | undefined {
    return this.faqs.get(id);
  }
}
```

- [ ] **Step 6: 지식 저장소 작성**

`jev-chat-api/src/adapters/persistence/knowledge.repository.ts`:
```ts
import type { Chunk, Faq, IntentId } from "../../core";
import type { PrismaClient } from "../../generated/prisma/client";
import type { DomainPack } from "../knowledge/pack-loader";

export interface ActiveKnowledge {
  versionId: string;
  pack: Omit<DomainPack, "chunks" | "faqs" | "contentHash">;
  chunks: Chunk[];
  faqs: Faq[];
}

type PackSnapshot = Omit<DomainPack, "chunks" | "faqs" | "contentHash">;

export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * [P7] 원자 import: knowledge_state(id=1) 행을 FOR UPDATE로 잠가 동시 import를 직렬화하고,
   * 잠금 안에서 활성 버전의 contentHash를 다시 비교한다. 실패하면 전체 롤백(실패 버전 행을 남기지 않음).
   */
  async importPack(pack: DomainPack): Promise<{ versionId: string; skipped: boolean }> {
    const snapshot: PackSnapshot = { manifest: pack.manifest, policy: pack.policy, intents: pack.intents };
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT IGNORE INTO knowledge_state (id, active_version_id) VALUES (1, NULL)`;
        const rows = await tx.$queryRaw<{ active_version_id: string | null }[]>`SELECT active_version_id FROM knowledge_state WHERE id = 1 FOR UPDATE`;
        const activeId = rows[0]?.active_version_id ?? null;
        if (activeId) {
          const active = await tx.knowledgeVersion.findUnique({ where: { id: activeId }, select: { contentHash: true } });
          if (active?.contentHash === pack.contentHash) return { versionId: activeId, skipped: true };
        }
        const v = await tx.knowledgeVersion.create({
          data: {
            packName: pack.manifest.name,
            packVersion: pack.manifest.version,
            contentHash: pack.contentHash,
            status: "active",
            packSnapshot: snapshot as object,
          },
        });
        await tx.knowledgeChunk.createMany({
          data: pack.chunks.map((c) => ({
            versionId: v.id,
            id: c.id,
            module: c.module,
            kind: c.kind,
            title: c.title,
            section: c.section,
            text: c.text,
            tags: c.tags,
            updatedAt: c.updatedAt,
            contentHash: c.contentHash,
          })),
        });
        await tx.faq.createMany({
          data: pack.faqs.map((f) => ({
            versionId: v.id,
            id: f.id,
            intent: f.intent,
            summary: f.summary,
            appliesWhen: f.appliesWhen,
            answer: f.answer,
            sourceChunkId: f.sourceChunkId,
          })),
        });
        await tx.faqVariant.createMany({
          data: pack.faqs.flatMap((f) => f.variants.map((text) => ({ versionId: v.id, faqId: f.id, text }))),
        });
        if (activeId) await tx.knowledgeVersion.update({ where: { id: activeId }, data: { status: "archived" } });
        await tx.knowledgeState.update({ where: { id: 1 }, data: { activeVersionId: v.id } });
        return { versionId: v.id, skipped: false };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  }

  async loadActive(): Promise<ActiveKnowledge | null> {
    const state = await this.prisma.knowledgeState.findUnique({ where: { id: 1 } });
    if (!state?.activeVersionId) return null;
    const v = await this.prisma.knowledgeVersion.findUnique({ where: { id: state.activeVersionId } });
    if (!v) return null;
    const [chunkRows, faqRows] = await Promise.all([
      this.prisma.knowledgeChunk.findMany({ where: { versionId: v.id }, orderBy: { id: "asc" } }),
      this.prisma.faq.findMany({ where: { versionId: v.id }, include: { variants: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } }),
    ]);
    return {
      versionId: v.id,
      pack: v.packSnapshot as unknown as PackSnapshot,
      chunks: chunkRows.map((c) => ({
        id: c.id,
        module: c.module,
        kind: c.kind,
        title: c.title,
        section: c.section,
        text: c.text,
        tags: c.tags as string[],
        updatedAt: c.updatedAt,
        contentHash: c.contentHash,
      })),
      faqs: faqRows.map((f) => ({
        id: f.id,
        intent: f.intent as IntentId,
        summary: f.summary,
        appliesWhen: f.appliesWhen,
        answer: f.answer,
        sourceChunkId: f.sourceChunkId,
        variants: f.variants.map((v) => v.text),
      })),
    };
  }
}
```

- [ ] **Step 7: import CLI 작성**

`jev-chat-api/src/scripts/knowledge-import.ts`:
```ts
import "dotenv/config";
import { resolve } from "node:path";
import { loadDomainPack, PackValidationError } from "../adapters/knowledge/pack-loader";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { validateEnv } from "../app/config/env.schema";

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const dir = resolve(process.cwd(), process.argv[2] ?? env.DOMAIN_PACK_DIR);
  const prisma = createPrismaClient({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: 2,
  });
  try {
    const pack = await loadDomainPack(dir);
    const result = await new KnowledgeRepository(prisma).importPack(pack);
    console.log(
      result.skipped
        ? `변경 없음: 활성 버전 ${result.versionId}와 내용이 같습니다.`
        : `적재 완료: 버전 ${result.versionId} (청크 ${pack.chunks.length}, FAQ ${pack.faqs.length}). 실행 중인 서버는 POST /api/admin/knowledge/reload로 반영하세요.`,
    );
  } catch (e) {
    if (e instanceof PackValidationError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
```

- [ ] **Step 8: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test -- knowledge` (단위) 그리고 `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test -- knowledge.repository` (통합)
Expected: 로더 7건 PASS, 저장소 통합 4건 PASS (URL 없으면 skip)

- [ ] **Step 9: 커밋**

```bash
git add jev-chat-api/src/adapters/knowledge jev-chat-api/src/adapters/persistence/knowledge.repository* jev-chat-api/src/scripts
git commit -m "feat(api): domain-pack 검증 로더, 지식 버전 저장소, knowledge:import CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 실행 스냅샷 서비스 + 턴 저장소(ContextReader) + 앱 조립

**Files:**
- Create: `jev-chat-api/src/adapters/persistence/turn.repository.ts`
- Create: `jev-chat-api/src/app/knowledge/snapshot.service.ts`, `jev-chat-api/src/app/persistence.module.ts`, `jev-chat-api/src/app/jev.module.ts`
- Modify: `jev-chat-api/src/app/app.module.ts`
- Test: `jev-chat-api/src/app/knowledge/snapshot.service.spec.ts`, `jev-chat-api/src/adapters/persistence/turn.repository.spec.ts`

**Interfaces:**
- Consumes: `KnowledgeRepository`, `ActiveKnowledge`, `MapKnowledgeReader`, core `Bm25Retriever`, `ExecutionSnapshot`, `TEMPLATE_VERSION`, `ContextReader`, `CompletedTurn`, `EngineResult`, `TraceRecord`, `SourceRef`
- Produces:
  - `class SnapshotService` — `constructor(loader: { loadActive(): Promise<ActiveKnowledge | null> }, opts: { limiterWaitMs: number })`, `init(): Promise<void>`(활성 팩 template_version 불일치 시 `TemplateVersionMismatchError`), `current(): ExecutionSnapshot`(없으면 throw `NoActiveKnowledgeError`), `reload(): Promise<{ versionId: string; changed: boolean }>` (single-flight: 진행 중이면 같은 promise 반환, 실패 시 이전 스냅샷 유지)
  - `class NoActiveKnowledgeError extends Error`
  - `PRISMA = Symbol("PRISMA")`, `PersistenceModule`, `JevModule`(provider: `JevLimiter`, `JEV_TRANSPORT`, `JUDGE`)
  - `class TurnRepository implements ContextReader` —
    - `createSession(userId: string, channel: string): Promise<{ id: string }>`
    - `findSession(id: string): Promise<{ id: string; userId: string } | null>`
    - `findTurnByClientMsgId(sessionId: string, clientMsgId: string): Promise<TurnRow | null>`
    - `reserveTurn(input: { sessionId: string; clientMsgId: string; userText: string; retryOfTurnSeq?: number }): Promise<TurnRow>` (next_turn_seq 증가 + 삽입을 한 트랜잭션)
    - `completeTurn(turnId: string, result: EngineResult, opts?: { saveMs?: number }): Promise<{ traceId: string } | null>` (`status='processing'`일 때만, 턴 갱신 + trace 삽입 한 트랜잭션; route=error면 errorCode/errorRetryable도 저장; 이미 완료/실패면 null; 저장 기한 초과 시 롤백 후 throw)
    - `failTurn(turnId: string, code: string, retryable: boolean, trace?: TraceRecord, opts?: { saveMs?: number }): Promise<boolean>`
    - `sweepProcessing(code: string): Promise<number>` (모든 processing → failed, retryable=true)
    - `loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]>`
    - `listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }): Promise<{ turns: TurnRow[]; hasMore: boolean }>` (turn_seq 오름차순 반환)
    - `interface TurnRow { id; sessionId; turnSeq; clientMsgId; userText; status: "processing" | "completed" | "failed"; errorCode: string | null; errorRetryable: boolean | null; assistantText: string | null; route: string | null; sources: SourceRef[] | null; traceId: string | null; createdAt: Date }`

- [ ] **Step 1: 실패 테스트 작성**

`jev-chat-api/src/app/knowledge/snapshot.service.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NoActiveKnowledgeError, SnapshotService, TemplateVersionMismatchError } from "./snapshot.service";
import type { ActiveKnowledge } from "../../adapters/persistence/knowledge.repository";
import { DEFAULT_INTENTS, DEFAULT_POLICY } from "../../core";

const make = (loader: ConstructorParameters<typeof SnapshotService>[0]) => new SnapshotService(loader, { limiterWaitMs: 3000 });

function active(versionId: string, text = "법인카드 1회 한도 50만 원"): ActiveKnowledge {
  return {
    versionId,
    pack: {
      manifest: { name: "t", version: "1", language: "ko", helpdesk: { phone: "1", email: "e" }, templateVersion: "v1" },
      policy: DEFAULT_POLICY,
      intents: DEFAULT_INTENTS,
    },
    chunks: [{ id: "c1", module: "m", kind: "regulation", title: "법인카드 규정", section: "한도", text, tags: [], updatedAt: "2026-01-01", contentHash: "h" }],
    faqs: [],
  };
}

describe("SnapshotService", () => {
  it("init 전 current()는 NoActiveKnowledgeError", () => {
    const s = make({ loadActive: async () => active("v1") });
    expect(() => s.current()).toThrow(NoActiveKnowledgeError);
  });

  it("init 후 활성 버전으로 스냅샷을 만든다", async () => {
    const s = make({ loadActive: async () => active("v1") });
    await s.init();
    const snap = s.current();
    expect(snap.knowledgeVersionId).toBe("v1");
    expect(snap.templateVersion).toBe("v1");
    expect(snap.retriever.searchChunks(["법인카드 한도"], 8)[0]?.chunk.id).toBe("c1");
    expect(snap.knowledge.getChunk("c1")?.title).toBe("법인카드 규정");
    expect(snap.helpdesk.phone).toBe("1");
  });

  it("active가 없으면 init은 성공하되 current()는 throw", async () => {
    const s = make({ loadActive: async () => null });
    await s.init();
    expect(() => s.current()).toThrow(NoActiveKnowledgeError);
  });

  it("reload는 참조를 통째로 교체한다 — 기존에 잡아둔 스냅샷은 그대로", async () => {
    let next = active("v1");
    const s = make({ loadActive: async () => next });
    await s.init();
    const held = s.current();
    next = active("v2");
    expect(await s.reload()).toEqual({ versionId: "v2", changed: true });
    expect(s.current().knowledgeVersionId).toBe("v2");
    expect(held.knowledgeVersionId).toBe("v1");
  });

  it("같은 버전이면 changed=false", async () => {
    const s = make({ loadActive: async () => active("v1") });
    await s.init();
    expect(await s.reload()).toEqual({ versionId: "v1", changed: false });
  });

  it("동시 reload는 한 번만 실행된다(single-flight)", async () => {
    let calls = 0;
    const s = make({
      loadActive: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return active("v1");
      },
    });
    await Promise.all([s.reload(), s.reload(), s.reload()]);
    expect(calls).toBe(1);
  });

  it("[P10] 스냅샷 policy의 limiterMs는 서버 설정값", async () => {
    const s = new SnapshotService({ loadActive: async () => active("v1") }, { limiterWaitMs: 1234 });
    await s.init();
    expect(s.current().policy.deadlines.limiterMs).toBe(1234);
  });

  it("[P10] 활성 팩의 template_version이 다르면 init 실패, reload는 이전 스냅샷 유지", async () => {
    const bad = active("v9");
    bad.pack.manifest.templateVersion = "v0";
    await expect(make({ loadActive: async () => bad }).init()).rejects.toBeInstanceOf(TemplateVersionMismatchError);
    let next = active("v1");
    const s = make({ loadActive: async () => next });
    await s.init();
    next = bad;
    await expect(s.reload()).rejects.toBeInstanceOf(TemplateVersionMismatchError);
    expect(s.current().knowledgeVersionId).toBe("v1");
  });

  it("reload 실패 시 이전 스냅샷을 유지하고 오류를 전달한다", async () => {
    let fail = false;
    const s = make({
      loadActive: async () => {
        if (fail) throw new Error("db down");
        return active("v1");
      },
    });
    await s.init();
    fail = true;
    await expect(s.reload()).rejects.toThrow("db down");
    expect(s.current().knowledgeVersionId).toBe("v1");
  });
});
```

`jev-chat-api/src/adapters/persistence/turn.repository.spec.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../core";
import { resetTestDb, testPrisma } from "./prisma";
import { TurnRepository } from "./turn.repository";

const prisma = testPrisma();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function result(text: string, route: EngineResult["route"] = "faq"): EngineResult {
  return {
    route,
    text,
    sources: [{ chunkId: "c1", versionId: "v1", contentHash: "h", title: "법인카드 규정", section: "한도" }],
    trace: {
      knowledgeVersionId: "v1", templateVersion: "v1", model: "jev-1.13.0", policy: {} as never, contextTurnSeqs: [],
      intent: "regulation", intentProbs: null, inScope: 0.95, ambiguity: 0.1, faqChoice: "f", faqProb: 0.9, faqConfidence: 0.8,
      route, retrieval: { faqQuery: "q", chunkQueries: ["q"], faqCandidateIds: [], chunkCandidateIds: [] }, candidates: [],
      bStatus: "skipped", jevCalls: [], latencyMs: { retrieval: 1, turn: 1, relevance: null, total: 2 }, totalInputTokens: 123, errorCode: null,
    },
  };
}

describe.runIf(prisma)("TurnRepository (통합)", () => {
  const repo = new TurnRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("reserveTurn은 turn_seq를 1부터 증가시킨다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t1 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "a" });
    const t2 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(2), userText: "b", retryOfTurnSeq: 1 });
    expect([t1.turnSeq, t2.turnSeq]).toEqual([1, 2]);
    expect(t1.status).toBe("processing");
  });

  it("동시 reserveTurn도 turn_seq가 겹치지 않는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const turns = await Promise.all([1, 2, 3, 4, 5].map((n) => repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: "x" })));
    expect(turns.map((t) => t.turnSeq).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("completeTurn: 턴 갱신 + trace 저장, 두 번째 완료는 null", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "한도?" });
    const done = await repo.completeTurn(t.id, result("50만 원입니다."));
    expect(done?.traceId).toBeTruthy();
    expect(await repo.completeTurn(t.id, result("중복"))).toBeNull();
    const row = await repo.findTurnByClientMsgId(s.id, uuid(1));
    expect(row).toMatchObject({ status: "completed", assistantText: "50만 원입니다.", route: "faq", traceId: done?.traceId });
    expect(row?.sources?.[0]?.chunkId).toBe("c1");
    const trace = await prisma!.messageTrace.findUnique({ where: { turnId: t.id } });
    expect(trace).toMatchObject({ totalInputTokens: 123, bStatus: "skipped", intent: "regulation" });
  });

  it("[P4] route=error 완료는 error 메타데이터를 함께 저장, 정상 완료는 비운다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const r = result("일시적인 문제", "error");
    r.trace.errorCode = "JEV_UNAVAILABLE";
    await repo.completeTurn(t.id, r);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "completed", route: "error", errorCode: "JEV_UNAVAILABLE", errorRetryable: true });
    const t2 = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(2), userText: "q2" });
    await repo.completeTurn(t2.id, result("정상"));
    expect(await repo.findTurnByClientMsgId(s.id, uuid(2))).toMatchObject({ errorCode: null, errorRetryable: null });
  });

  it("[P9] trace 삽입이 실패하면 전체 롤백 — 턴은 processing으로 남는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const bad = result("답");
    bad.trace.knowledgeVersionId = "x".repeat(40); // CHAR(36) 초과 → trace insert 실패
    await expect(repo.completeTurn(t.id, bad)).rejects.toThrow();
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "processing", assistantText: null, traceId: null });
  });

  it("[P9] complete와 fail이 동시에 와도 하나만 종료 상태를 만든다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    const [done, failed] = await Promise.all([repo.completeTurn(t.id, result("답")), repo.failTurn(t.id, "INTERNAL", false)]);
    expect(Number(done !== null) + Number(failed)).toBe(1);
    const row = await repo.findTurnByClientMsgId(s.id, uuid(1));
    expect(row?.status).toBe(done !== null ? "completed" : "failed");
    expect(await prisma!.messageTrace.count({ where: { turnId: t.id } })).toBe(done !== null ? 1 : 0);
  });

  it("[P5·P9] 저장 기한을 넘기면 트랜잭션이 롤백되고 늦은 완료가 남지 않는다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    // 다른 트랜잭션이 턴 행을 2.5초 동안 잠근다 → completeTurn(saveMs 1000)은 잠금 대기 중 기한 초과
    const holder = prisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_turns WHERE id = ${t.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 2500));
    }, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    await expect(repo.completeTurn(t.id, result("늦은 답"), { saveMs: 1000 })).rejects.toThrow();
    await holder;
    await new Promise((r) => setTimeout(r, 500));
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "processing", assistantText: null, traceId: null });
    expect(await prisma!.messageTrace.count({ where: { turnId: t.id } })).toBe(0);
  });

  it("failTurn은 processing일 때만 실패로 바꾼다", async () => {
    const s = await repo.createSession("u1", "front-test");
    const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    expect(await repo.failTurn(t.id, "INTERNAL", false)).toBe(true);
    expect(await repo.failTurn(t.id, "INTERNAL", false)).toBe(false);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "failed", errorCode: "INTERNAL", errorRetryable: false });
  });

  it("sweepProcessing은 남은 processing을 failed(retryable)로 바꾼다", async () => {
    const s = await repo.createSession("u1", "front-test");
    await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(1), userText: "q" });
    expect(await repo.sweepProcessing("RESTARTED")).toBe(1);
    expect(await repo.findTurnByClientMsgId(s.id, uuid(1))).toMatchObject({ status: "failed", errorCode: "RESTARTED", errorRetryable: true });
  });

  it("loadCompletedTurns: 이전 완료 턴만, 오름차순, limit개, 출처(title·section) 포함", async () => {
    const s = await repo.createSession("u1", "front-test");
    for (let n = 1; n <= 4; n++) {
      const t = await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: `q${n}` });
      if (n !== 3) await repo.completeTurn(t.id, result(`a${n}`));
    }
    const turns = await repo.loadCompletedTurns(s.id, 4, 2);
    expect(turns.map((t) => t.turnSeq)).toEqual([1, 2]);
    expect(turns[0]).toEqual({ turnSeq: 1, userText: "q1", assistantText: "a1", sources: [{ title: "법인카드 규정", section: "한도" }] });
  });

  it("listTurns: 최신 limit개를 오름차순으로, hasMore 계산", async () => {
    const s = await repo.createSession("u1", "front-test");
    for (let n = 1; n <= 3; n++) await repo.reserveTurn({ sessionId: s.id, clientMsgId: uuid(n), userText: `q${n}` });
    const page = await repo.listTurns(s.id, { limit: 2 });
    expect(page.turns.map((t) => t.turnSeq)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);
    const older = await repo.listTurns(s.id, { limit: 2, beforeTurnSeq: 2 });
    expect(older).toMatchObject({ hasMore: false });
    expect(older.turns.map((t) => t.turnSeq)).toEqual([1]);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `pnpm --filter jev-chat-api test -- snapshot turn.repository`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 스냅샷 서비스 작성**

`jev-chat-api/src/app/knowledge/snapshot.service.ts`:
```ts
import { Bm25Retriever, TEMPLATE_VERSION, type ExecutionSnapshot } from "../../core";
import type { ActiveKnowledge } from "../../adapters/persistence/knowledge.repository";
import { MapKnowledgeReader } from "../../adapters/knowledge/map-knowledge";

export class NoActiveKnowledgeError extends Error {
  constructor() {
    super("활성 지식 버전이 없습니다. pnpm knowledge:import를 먼저 실행하세요.");
    this.name = "NoActiveKnowledgeError";
  }
}

export class TemplateVersionMismatchError extends Error {
  constructor(packVersion: string) {
    super(`활성 지식 팩의 template_version(${packVersion})이 서버 코드(${TEMPLATE_VERSION})와 다릅니다. 팩을 갱신해 다시 import하세요.`);
    this.name = "TemplateVersionMismatchError";
  }
}

function buildSnapshot(a: ActiveKnowledge, limiterWaitMs: number): ExecutionSnapshot {
  // [P10] 재배포 후에도 활성 팩이 현재 질문 템플릿과 호환되는지 확인
  if (a.pack.manifest.templateVersion !== TEMPLATE_VERSION) throw new TemplateVersionMismatchError(a.pack.manifest.templateVersion);
  return {
    knowledgeVersionId: a.versionId,
    // [P10] 제한기 대기는 서버 설정값을 기록해 trace의 policy가 실제 동작과 일치하게 한다
    policy: { ...a.pack.policy, deadlines: { ...a.pack.policy.deadlines, limiterMs: limiterWaitMs } },
    intents: a.pack.intents,
    helpdesk: a.pack.manifest.helpdesk,
    templateVersion: TEMPLATE_VERSION,
    retriever: new Bm25Retriever(a.faqs, a.chunks),
    knowledge: new MapKnowledgeReader(a.versionId, a.chunks, a.faqs),
  };
}

/** 실행 스냅샷을 보관한다. 메시지 하나는 처리 시작 시 current()로 받은 스냅샷만 끝까지 쓴다. */
export class SnapshotService {
  private snapshot: ExecutionSnapshot | null = null;
  private inflight: Promise<{ versionId: string; changed: boolean }> | null = null;

  constructor(
    private readonly loader: { loadActive(): Promise<ActiveKnowledge | null> },
    private readonly opts: { limiterWaitMs: number },
  ) {}

  /** 활성 팩이 템플릿과 호환되지 않으면 TemplateVersionMismatchError로 부팅을 실패시킨다(조용히 잘못 동작하지 않음). */
  async init(): Promise<void> {
    const a = await this.loader.loadActive();
    if (a) this.snapshot = buildSnapshot(a, this.opts.limiterWaitMs);
  }

  current(): ExecutionSnapshot {
    if (!this.snapshot) throw new NoActiveKnowledgeError();
    return this.snapshot;
  }

  reload(): Promise<{ versionId: string; changed: boolean }> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const a = await this.loader.loadActive();
        if (!a) throw new NoActiveKnowledgeError();
        const prev = this.snapshot?.knowledgeVersionId ?? null;
        const next = buildSnapshot(a, this.opts.limiterWaitMs); // 빌드가 끝난 뒤에만 교체
        this.snapshot = next;
        return { versionId: a.versionId, changed: prev !== a.versionId };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
```

- [ ] **Step 4: 턴 저장소 작성**

`jev-chat-api/src/adapters/persistence/turn.repository.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { CompletedTurn, ContextReader, EngineResult, SourceRef, TraceRecord } from "../../core";
import type { PrismaClient } from "../../generated/prisma/client";

export interface TurnRow {
  id: string;
  sessionId: string;
  turnSeq: number;
  clientMsgId: string;
  userText: string;
  status: "processing" | "completed" | "failed";
  errorCode: string | null;
  errorRetryable: boolean | null;
  assistantText: string | null;
  route: string | null;
  sources: SourceRef[] | null;
  traceId: string | null;
  createdAt: Date;
}

type TurnWithTrace = {
  id: string;
  sessionId: string;
  turnSeq: number;
  clientMsgId: string;
  userText: string;
  status: "processing" | "completed" | "failed";
  errorCode: string | null;
  errorRetryable: boolean | null;
  assistantText: string | null;
  route: string | null;
  sources: unknown;
  createdAt: Date;
  trace: { id: string } | null;
};

function toRow(t: TurnWithTrace): TurnRow {
  return {
    id: t.id,
    sessionId: t.sessionId,
    turnSeq: t.turnSeq,
    clientMsgId: t.clientMsgId,
    userText: t.userText,
    status: t.status,
    errorCode: t.errorCode,
    errorRetryable: t.errorRetryable,
    assistantText: t.assistantText,
    route: t.route,
    sources: (t.sources as SourceRef[] | null) ?? null,
    traceId: t.trace?.id ?? null,
    createdAt: t.createdAt,
  };
}

function traceColumns(turnId: string, trace: TraceRecord) {
  return {
    turnId,
    knowledgeVersionId: trace.knowledgeVersionId,
    templateVersion: trace.templateVersion,
    modelVersion: trace.model,
    route: trace.route,
    intent: trace.intent,
    inScope: trace.inScope,
    ambiguity: trace.ambiguity,
    faqChoice: trace.faqChoice,
    faqProb: trace.faqProb,
    faqConfidence: trace.faqConfidence,
    bStatus: trace.bStatus,
    totalInputTokens: trace.totalInputTokens,
    errorCode: trace.errorCode,
    data: JSON.parse(JSON.stringify(trace)) as object,
  };
}

const withTrace = { trace: { select: { id: true } } } as const;

export class TurnRepository implements ContextReader {
  constructor(private readonly prisma: PrismaClient) {}

  async createSession(userId: string, channel: string): Promise<{ id: string }> {
    return this.prisma.chatSession.create({ data: { id: randomUUID(), userId, channel }, select: { id: true } });
  }

  findSession(id: string): Promise<{ id: string; userId: string } | null> {
    return this.prisma.chatSession.findUnique({ where: { id }, select: { id: true, userId: true } });
  }

  async findTurnByClientMsgId(sessionId: string, clientMsgId: string): Promise<TurnRow | null> {
    const t = await this.prisma.chatTurn.findUnique({ where: { sessionId_clientMsgId: { sessionId, clientMsgId } }, include: withTrace });
    return t ? toRow(t) : null;
  }

  async reserveTurn(input: { sessionId: string; clientMsgId: string; userText: string; retryOfTurnSeq?: number }): Promise<TurnRow> {
    const t = await this.prisma.$transaction(async (tx) => {
      // 행 잠금 + 원자 증가: 동시 예약에서도 turn_seq가 겹치지 않는다.
      const s = await tx.chatSession.update({
        where: { id: input.sessionId },
        data: { nextTurnSeq: { increment: 1 }, lastActiveAt: new Date() },
        select: { nextTurnSeq: true },
      });
      return tx.chatTurn.create({
        data: {
          sessionId: input.sessionId,
          turnSeq: s.nextTurnSeq - 1,
          clientMsgId: input.clientMsgId,
          userText: input.userText,
          retryOfTurnSeq: input.retryOfTurnSeq ?? null,
          status: "processing",
        },
        include: withTrace,
      });
    });
    return toRow(t);
  }

  /**
   * [P5] 저장 기한(saveMs, 기본 3000ms)을 트랜잭션 획득 대기 + 실행 시간에 나눠 적용한다.
   * 기한을 넘기면 Prisma가 트랜잭션을 롤백하고 예외를 던진다 — 호출자는 결과를 확인한 뒤에만 이벤트를 보낸다.
   */
  private txOptions(saveMs = 3000): { maxWait: number; timeout: number } {
    // saveMs는 팩 검증에서 1000 이상이 보장된다. 합계(maxWait+timeout)가 saveMs를 넘지 않게 나눈다.
    const budget = Math.max(1000, saveMs);
    const maxWait = Math.min(1000, Math.floor(budget / 3));
    return { maxWait, timeout: budget - maxWait };
  }

  async completeTurn(turnId: string, result: EngineResult, opts: { saveMs?: number } = {}): Promise<{ traceId: string } | null> {
    // [P4] 장애 안내(route=error)도 completed 턴이며, 재연결 시 error 메타데이터를 복원할 수 있게 함께 저장한다.
    const isError = result.route === "error";
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.chatTurn.updateMany({
        where: { id: turnId, status: "processing" },
        data: {
          status: "completed",
          assistantText: result.text,
          route: result.route,
          sources: result.sources as unknown as object,
          errorCode: isError ? (result.trace.errorCode ?? "JEV_UNAVAILABLE") : null,
          errorRetryable: isError ? true : null,
          completedAt: new Date(),
        },
      });
      if (updated.count === 0) return null;
      const trace = await tx.messageTrace.create({ data: traceColumns(turnId, result.trace), select: { id: true } });
      return { traceId: trace.id };
    }, this.txOptions(opts.saveMs));
  }

  async failTurn(turnId: string, code: string, retryable: boolean, trace?: TraceRecord, opts: { saveMs?: number } = {}): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.chatTurn.updateMany({
        where: { id: turnId, status: "processing" },
        data: { status: "failed", errorCode: code, errorRetryable: retryable, completedAt: new Date() },
      });
      if (updated.count === 0) return false;
      if (trace) await tx.messageTrace.create({ data: traceColumns(turnId, trace) });
      return true;
    }, this.txOptions(opts.saveMs));
  }

  async sweepProcessing(code: string): Promise<number> {
    const r = await this.prisma.chatTurn.updateMany({
      where: { status: "processing" },
      data: { status: "failed", errorCode: code, errorRetryable: true, completedAt: new Date() },
    });
    return r.count;
  }

  async loadCompletedTurns(sessionId: string, beforeTurnSeq: number, limit: number): Promise<CompletedTurn[]> {
    const rows = await this.prisma.chatTurn.findMany({
      where: { sessionId, status: "completed", turnSeq: { lt: beforeTurnSeq } },
      orderBy: { turnSeq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      turnSeq: r.turnSeq,
      userText: r.userText,
      assistantText: r.assistantText ?? "",
      sources: ((r.sources as SourceRef[] | null) ?? []).map((s) => ({ title: s.title, section: s.section })),
    }));
  }

  async listTurns(sessionId: string, opts: { beforeTurnSeq?: number; limit: number }): Promise<{ turns: TurnRow[]; hasMore: boolean }> {
    const rows = await this.prisma.chatTurn.findMany({
      where: { sessionId, ...(opts.beforeTurnSeq ? { turnSeq: { lt: opts.beforeTurnSeq } } : {}) },
      orderBy: { turnSeq: "desc" },
      take: opts.limit + 1,
      include: withTrace,
    });
    const hasMore = rows.length > opts.limit;
    return { turns: rows.slice(0, opts.limit).reverse().map(toRow), hasMore };
  }
}
```

- [ ] **Step 5: Nest 모듈 조립**

`jev-chat-api/src/app/persistence.module.ts`:
```ts
import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import type { PrismaClient } from "../generated/prisma/client";
import { ENV, type Env } from "./config/env.schema";

export const PRISMA = Symbol("PRISMA");

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: (env: Env) =>
        createPrismaClient({
          host: env.DB_HOST,
          port: env.DB_PORT,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          database: env.DB_NAME,
          connectionLimit: env.DB_CONNECTION_LIMIT,
        }),
    },
    { provide: KnowledgeRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new KnowledgeRepository(p) },
    { provide: TurnRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new TurnRepository(p) },
  ],
  exports: [PRISMA, KnowledgeRepository, TurnRepository],
})
export class PersistenceModule implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}
  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
```

`jev-chat-api/src/app/jev.module.ts`:
```ts
import { Global, Logger, Module } from "@nestjs/common";
import type { Judge } from "../core";
import { JevLimiter } from "../adapters/jev/limiter";
import { SdkJevTransport } from "../adapters/jev/sdk-transport";
import type { JevTransport } from "../adapters/jev/transport";
import { TypesafeJudge } from "../adapters/jev/typesafe-judge";
import { ENV, type Env } from "./config/env.schema";

export const JEV_TRANSPORT = Symbol("JEV_TRANSPORT");
export const JUDGE = Symbol("JUDGE");

@Global()
@Module({
  providers: [
    {
      provide: JevLimiter,
      inject: [ENV],
      useFactory: (env: Env) =>
        new JevLimiter({
          maxConcurrent: env.JEV_MAX_CONCURRENT,
          maxRequestsPerSecond: env.JEV_MAX_RPS,
          maxTokensPerSecond: env.JEV_MAX_TPS,
          maxWaitMs: env.JEV_LIMITER_WAIT_MS,
        }),
    },
    {
      provide: JEV_TRANSPORT,
      inject: [ENV],
      useFactory: (env: Env): JevTransport => {
        const log = new Logger("TypeSafeSDK");
        return new SdkJevTransport({
          apiKey: env.TYPESAFE_API_KEY,
          ...(env.TYPESAFE_BASE_URL ? { baseURL: env.TYPESAFE_BASE_URL } : {}),
          logger: {
            debug: (m) => log.debug(m),
            info: (m) => log.log(m),
            warn: (m) => log.warn(m),
            error: (m) => log.error(m),
          },
        });
      },
    },
    {
      provide: JUDGE,
      inject: [ENV, JevLimiter, JEV_TRANSPORT],
      useFactory: (env: Env, limiter: JevLimiter, transport: JevTransport): Judge =>
        new TypesafeJudge({ transport, limiter, attemptTimeoutMs: env.JEV_ATTEMPT_TIMEOUT_MS, maxRetryWaitMs: env.JEV_MAX_RETRY_WAIT_MS }),
    },
  ],
  exports: [JevLimiter, JUDGE],
})
export class JevModule {}
```
※ [P10] 제한기는 같은 API 키를 쓰는 전역 자원이므로 대기 상한은 **서버 설정**(`JEV_LIMITER_WAIT_MS`)이다. domain-pack policy에서는 `limiter_ms`를 받지 않고, SnapshotService가 실행 스냅샷의 `policy.deadlines.limiterMs`에 이 서버 값을 넣어 trace에 실제 값이 기록되게 한다.

`jev-chat-api/src/app/app.module.ts` 교체:
```ts
import { Module, type DynamicModule, type OnApplicationBootstrap, Inject } from "@nestjs/common";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import { ENV, type Env } from "./config/env.schema";
import { HealthController } from "./health.controller";
import { JevModule } from "./jev.module";
import { SnapshotService } from "./knowledge/snapshot.service";
import { PersistenceModule } from "./persistence.module";

@Module({})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(TurnRepository) private readonly turns: TurnRepository,
  ) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [PersistenceModule, JevModule],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: SnapshotService,
          inject: [KnowledgeRepository],
          useFactory: (repo: KnowledgeRepository) => new SnapshotService(repo, { limiterWaitMs: env.JEV_LIMITER_WAIT_MS }),
        },
      ],
      exports: [ENV, SnapshotService],
    };
  }

  /** 부팅 시: 재시작 전 처리 중이던 턴 정리 → 활성 지식 스냅샷 로드 */
  async onApplicationBootstrap(): Promise<void> {
    await this.turns.sweepProcessing("RESTARTED");
    await this.snapshots.init();
  }
}
```

- [ ] **Step 5-1: 앱 전체 DI·라우팅 HTTP 테스트 작성** [P9]

`jev-chat-api/src/app/app.e2e.spec.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbConfigFromUrl } from "../adapters/persistence/prisma";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.schema";

const url = process.env.TEST_DATABASE_URL;

describe.runIf(url)("앱 부팅 (통합)", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const db = dbConfigFromUrl(url!);
    const env = validateEnv({
      NODE_ENV: "test",
      TYPESAFE_API_KEY: "test-key-not-used",
      DB_HOST: db.host,
      DB_PORT: String(db.port),
      DB_USER: db.user,
      DB_PASSWORD: db.password,
      DB_NAME: db.database,
      AUTH_MODE: "dev",
      DEV_ACCESS_TOKEN: "t".repeat(32),
    });
    app = await NestFactory.create(AppModule.forRoot(env), { logger: false });
    await app.listen(0);
    base = await app.getUrl();
  });
  afterAll(async () => app?.close());

  it("GET /api/health → 200 {status:ok} (전체 DI 그래프 부팅 포함)", async () => {
    const res = await fetch(`${base.replace("[::1]", "127.0.0.1")}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 6: 실행 → 통과 확인**

Run: `pnpm --filter jev-chat-api test && pnpm --filter jev-chat-api typecheck` 그리고 `TEST_DATABASE_URL=… pnpm --filter jev-chat-api test`
Expected: 스냅샷 9건 PASS, 턴 저장소 통합 11건 PASS, 앱 부팅 1건 PASS(URL 없으면 통합은 skip), core 회귀 없음

- [ ] **Step 7: 부팅 스모크 테스트 (사람이 준비한 `.env`와 DB 필요)**

Run: `pnpm --filter jev-chat-api knowledge:import src/adapters/knowledge/__fixtures__/mini-pack` → `pnpm --filter jev-chat-api start:dev` (별도 터미널) → `curl -s localhost:3000/api/health`
Expected: import 시 "적재 완료" 출력, health는 `{"status":"ok"}`, 서버 로그에 env 값·키가 출력되지 않음. 확인 후 서버 종료.

- [ ] **Step 8: 커밋**

```bash
git add jev-chat-api
git commit -m "feat(api): 실행 스냅샷 서비스(원자 교체·single-flight), 턴 저장소, 앱 모듈 조립

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 완료 조건 (계획 2A)
- `pnpm test`, `pnpm typecheck` 통과 (DB 없이: 통합 테스트 skip)
- **`TEST_DATABASE_URL`을 준 상태에서 통합 테스트 전부 통과 — 실행 결과(통과 수, skip 0건)를 최종 보고에 별도 기록** [P9]. skip된 실행만으로는 완료로 보지 않는다.
- `prisma validate`, 생성 클라이언트 포함 전체 typecheck, 마이그레이션 SQL의 FK 동작 확인 [P6]
- `knowledge:import`로 미니 팩 적재, 서버 부팅 후 `/api/health` 응답
- 계획 2B가 사용할 것: `ENV`/`Env`, `PRISMA`, `TurnRepository`(+`TurnRow`), `KnowledgeRepository`, `SnapshotService`, `JUDGE`, `JevLimiter`, `createPrismaClient`, `testPrisma`/`resetTestDb`

---

### Task 6: 후속 정리 (Codex `2026-10-08-plan2a-t0-2-codex.md` T1~T4 + 구현자 Minor)

> Task 5 다음, 계획 2B 시작 전에 처리한다. 항목별 TDD + 커밋.

- [ ] **6-1 (T1) linkedController가 부모 신호의 수명을 보장**: 반환 객체가 부모 `AbortSignal`을 강하게 참조하도록 한다(`{ signal, abort, parent }`). 회귀 테스트는 별도 프로세스에서 `node --expose-gc`로 실행하는 스크립트 테스트로 추가한다: `linkedController(AbortSignal.timeout(300)).signal`만 유지 + 25ms마다 `gc()` → 1초 안에 abort되어야 한다(수정 전에는 미발화가 재현됨). 이 테스트는 `vitest`에서 `child_process.execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "<probe>.ts"])`로 실행한다.
- [ ] **6-2 (T2) 응답 형태 검증 강화**: `usage.input_tokens`/`output_tokens`는 0 이상의 **정수**, `model`은 빈 문자열 금지. 위반 시 `invalid_response`.
- [ ] **6-3 (T3) abortableSleep 정리**: 정상 만료 시 abort 리스너 제거(`{ once: true }` + `removeEventListener`).
- [ ] **6-4 (T4) B 합성 audit 원인 구분**: 엔진 기한 초과로 끝난 B는 `errorKind: "timeout"`, FAQ 조기 확정 등으로 취소된 B는 `"aborted"` — A와 같은 방식(`signal.reason`의 `TimeoutError` 여부)으로 기록.
- [ ] **6-5 SDK 시도 타임아웃 전달**: `systemOne` 호출 옵션에 `timeout: opts.timeoutMs`도 넘겨 SDK 기본 10초가 설정값을 덮지 않게 한다.
- [ ] **6-6 재시도 원인 보존**: 2차 시도가 제한기에 거절되면 audit `cause`에 1차 전송 원인을 유지하고 `limiterAfterRetry: true` 같은 보조 표시를 남긴다(`JevCallCause`에 선택 필드 `note?: string` 추가로 충분).
- [ ] **6-7 부팅 실패 처리**: `main.ts`를 `bootstrap().catch((e) => { console.error(e instanceof Error ? e.message : "부팅 실패"); process.exit(1); })`로 바꿔 env 검증 실패가 unhandled rejection이 아니라 명확한 종료가 되게 한다(메시지에 값이 들어가지 않음은 validateEnv가 보장).
- [ ] **6-8 테스트 보강**: env "비밀 값 미포함" 테스트에 `expect.assertions(1)`, health 라우팅은 Task 5의 `app.e2e.spec.ts`로 충족됨을 확인, 멈춘 ContextReader 테스트에 Judge 호출 0회·jevCalls 확인 추가, helpdesk 경계 테스트를 round9가 실제로 필요한 조합(`0.1+0.2+0.2`)으로 교체.
