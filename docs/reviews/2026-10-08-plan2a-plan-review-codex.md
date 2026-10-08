# 계획 2A 구현 전 검토

- 검토일: 2026-10-08.
- 대상: `docs/superpowers/plans/2026-10-08-plan2a-api-foundation.md`. 이하 `계획:행`은 이 파일 위치다.
- 기준: AGENTS.md, 설계 v3, `2026-10-08-plan1-checkpoint1-fixes.md`.
- 의견: **No-Go — 아래 Major 5건을 계획에 반영한 뒤 구현을 시작할 것을 권고한다.** 패키지 API 이름이 틀린 것이 주된 문제는 아니다. 토큰 예산 예외, 재시도/오류 증거, 완료 오류 메타데이터와 저장 기한이 핵심이다.
- 실제 env·시크릿은 읽지 않았다. 프로젝트 설치·기존 파일 수정·대상 패키지 런타임 실행·Prisma CLI 실행·DB 접속은 하지 않았다. 생성 파일은 지정 리뷰와 `/tmp/jev-plan2a-review`에 한정했다.

## 패키지 타입 확인 결과

기본 Node 20 대신 설치된 **Node 22.14.0**으로 npm을 실행했다. 최초 레지스트리 `npm pack --ignore-scripts`는 `ENOTFOUND registry.npmjs.org`로 실패했다. 오프라인 캐시 요청도 ENOTCACHED였다. 이후 기존 스크래치의 동일 버전 tarball 5개와 설치돼 있던 zod 4.6.5를 찾아 **`npm pack <로컬 아카이브/폴더> --ignore-scripts --offline`**으로 별도 폴더에 패킹했다. 각 archive의 package.json 이름·버전을 확인하고 타입 선언과 package.json만 추출했다. 새 레지스트리 다운로드/원격 무결성 대조까지 성공했다고 주장하지 않는다.

- 새 pack 및 타입 위치: `/tmp/jev-plan2a-review/{packs,types}`.
- 원 tarball 위치: `/tmp/claude-501/-Users-jeongbaul-Dev-SIDE-PROJECT-jev-chat/91b346c1-a27a-45cd-9475-b25c5b805f3a/scratchpad/{sdk-inspect,pkg-inspect}`.
- SDK/Prisma/Nest/zod의 JS는 실행하지 않았다. 기존 TypeScript 컴파일러는 noEmit 정적 검사에 사용했고, 별도로 **계획의 제한기 코드만** 임시 파일로 컴파일·실행했다.

| 지정 패키지 | 확인한 선언 / 결과 |
|---|---|
| `@typesafe-ai/sdk@0.6.0` | `dist/index.d.cts`/`.d.mts`: TypeSafeClient, systemOne, RequestOptions.signal, retry.maxRetries, logger/logLevel, fetch, 오류 클래스, RateLimitError.retryAfterMs와 APIError.headers 모두 존재한다. model/answers/usage.input_tokens/output_tokens 매핑도 맞다. |
| `prisma@7.10.0` | `config.d.ts`가 defineConfig/PrismaConfig를 `@prisma/config`에서 재수출한다. 기존 스크래치의 `@prisma/config@7.10.0` 선언도 보충 확인했고 schema/migrations/datasource.url 구조가 존재한다. |
| `@prisma/client@7.10.0` | runtime/client.d.ts의 adapter 옵션, InputJsonValue, transactionOptions 확인. 기본 트랜잭션 maxWait=2000ms, timeout=5000ms가 문서화돼 있다. **계획의 스키마로 생성된 모델 선언은 아직 없으므로 모델 API 전체 컴파일 검증은 아니다.** |
| `@prisma/adapter-mariadb@7.10.0` | dist/index.d.ts에 `PrismaMariaDb(poolOrConfig: mariadb.Pool \| mariadb.PoolConfig \| string, options?)`가 존재한다. 계획의 생성자 형태와 일치한다. PoolConfig 각 필드의 완전한 검증에는 의존 mariadb 선언이 추가로 필요하다. |
| `@nestjs/common@12.1.2` | Controller/Get/Module/Global/Inject, DynamicModule, OnModuleDestroy/OnApplicationBootstrap, Logger와 enableCors 선언을 확인했다. 패키지는 type=module이므로 Node 22의 CJS→ESM 사용 조건은 실제 부팅 테스트로 확인해야 한다. 이번에는 Nest 런타임을 실행하지 않았다. |
| `zod@4.6.5` | z.url, coerce.number, string.max, superRefine 및 관련 선언을 확인했다. 계획에 적힌 API 이름은 존재한다. 런타임 safeParse는 실행하지 않았다. |

SDK transport 블록을 스크래치에 추출하고 SDK 원본 `.d.cts`와 최소 core JevRequest 선언에 연결한 TypeScript noEmit 검사는 **통과**했다. `as never`가 입력 타입을 우회하므로 이것만으로 payload의 JSON 적합성까지 검증됐다고 볼 수 없다. `as object`와 Prisma InputJsonValue의 별도 대입 검사도 통과했으므로 이를 확정 컴파일 오류로 지적하지 않는다.

## 지적

### P1. Major · 빈 토큰 윈도우에서는 TPS 제한을 무조건 우회

- **위치:** 계획:894~900 (`limiter.ts`).
- **문제:** `usedTokens + tokens <= limit || window.length === 0` 때문에 첫 요청 또는 1초 쉬고 들어온 요청은 설정 토큰 상한보다 커도 실행된다. 전역 제한기가 최대 토큰 예산을 지킨다는 계약과 맞지 않는다.
- **근거:** 계획 코드를 스크래치에서 실행해 maxTokensPerSecond=100, 요청 추정치=101을 넣었을 때 release 함수를 반환하고 `{active:1, waiting:0}`이 됐다. 현재 기본 TPS 80k/요청 크기 상한 조합에서는 덜 드러나지만 TPS는 env로 낮출 수 있다. 테스트 474~477행은 이미 사용량이 있는 상태의 초과만 검사한다.
- **제안:** 윈도우가 비어도 상한을 적용한다. 개별 요청이 설정 예산보다 크면 대기시키지 말고 명시적으로 거절한다. 첫 요청 초과·동일값·윈도우 만료 직후·재시도 예산을 테스트한다. oversized 예외를 의도했다면 “TPS 상한”이라고 설명하면 안 된다.

### P2. Major · HTTP-date Retry-After를 무시하는 서버 오류 재시도

- **위치:** 계획:761~766, 779~781, 1082~1084.
- **문제:** retryAfterFrom은 숫자만 허용한다. 503 등 서버 오류에 HTTP-date 형식 Retry-After가 오면 undefined로 바뀌어 300ms 후 재시도한다. 공급자의 재시도 시각을 존중한다는 설계와 다르다.
- **근거:** 해당 helper는 Number(raw)가 유한수가 아니면 반환을 포기하고 Judge는 DEFAULT_BACKOFF_MS를 사용한다. SDK의 RateLimitError에는 자체 retryAfterMs가 있으므로 **429 전체가 반드시 이 문제를 가진다고 주장하지 않는다**. InternalServerError 분기는 직접 helper를 사용한다.
- **제안:** 밀리초/초 숫자와 HTTP-date를 구분해 현재 시각과의 차이를 계산하고, 음수·잘못된 헤더도 처리한다. 기다림이 엔진 기한을 넘기면 조기 종료하며 기한보다 일찍 재시도하지 않는다. 503+미래 HTTP-date와 caller abort 중 대기를 테스트한다.

### P3. Major · 내부 오류/공급자 장애를 구분할 trace 증거가 사라짐

- **위치:** 계획:783~784, 1047~1052, 1080~1084, 설계 6장 ERROR 처리(G1).
- **문제:** 미지의 전송 예외를 무조건 connection으로 분류·재시도하고, client(4xx)·429/529/5xx·제한기 자체 거절은 최종 audit에서 provider로 합쳐진다. 전송 오류의 status/kind를 audit에 보존하지 않아 G1의 “trace로 확인된 외부 장애만 평가 재실행”을 구현할 증거가 부족하다.
- **근거:** JevTransportError에는 status와 kind가 있지만 fail에는 message만 전달된다. 제한기 대기 실패도 provider이고 SDK가 아닌 프로그래밍/응답 해석 예외도 알 수 없는 connection으로 변환될 수 있다(후자는 발생 가능성 분석이며 SDK 런타임에서 재현한 것은 아니다). provider라는 값만으로 401 설정 오류와 503 외부 장애를 구분할 수 없다.
- **제안:** 알려진 SDK 연결/시간/HTTP 오류만 매핑하고 그 외 프로그래밍 예외는 재시도하지 않는다. 어댑터 audit에 허용된 transport kind/status와 로컬 limiter/기한 원인을 보존한다. core 공개 계약을 바꿔야 하면 “core 수정 금지” 규칙에 따라 선행 수정 결정으로 보고한다. 내부 실패·401·429·503·형식 오류가 평가에서 서로 다르게 집계되는 테스트를 둔다. 원문 오류/헤더/키 전체를 저장하지 않는다.

### P4. Major · 완료된 route=error의 error/retryable을 DB에서 복구할 수 없음

- **위치:** 계획:2481~2495 (`completeTurn`), 2370~2418 (`TurnRow/toRow`), 수정지시서 F5.
- **문제:** 완료 시 text/route/sources만 저장하고 errorCode/errorRetryable은 채우지 않는다. 장애 안내도 completed 턴인데, 재연결/중복 전송 시 프로토콜이 필수로 요구하는 error 메타데이터를 TurnRow에서 복원할 수 없다.
- **근거:** 수정지시서 F5는 route=error done 및 completed error 턴에 error를 필수로 정했다. completeTurn의 저장 필드에는 두 오류 컬럼이 없고 findTurn은 trace ID만 조회한다. trace에는 errorCode가 있어도 TurnRow에는 반영되지 않으며 retryable은 별도 저장되지 않는다. 계획 테스트는 정상 faq 완료만 확인한다.
- **제안:** 완료 결과가 route=error이면 서버가 정의한 오류 code/retryable을 두 컬럼에 함께 저장한다. 정상 완료에서는 오류 필드를 비운다. 완료 오류 턴을 list/find로 읽어 TurnSchema와 ChatDoneEventSchema를 실제 통과시키는 계약 테스트를 추가한다. 새 ID 재시도 정책도 유지한다.

### P5. Major · 저장 3초 기한과 Prisma 트랜잭션 수명이 맞지 않음

- **위치:** 계획:2482~2495, 2500~2509, 1885, 설계의 별도 저장 기한 3초.
- **문제:** completeTurn/failTurn은 transaction timeout/maxWait를 지정하지 않으며 기한 입력도 받지 않는다. app에서 3초 후 기다림만 포기하면 DB 트랜잭션이 그 뒤 커밋해 사용자에게 실패로 알린 턴이 completed로 남을 수 있다.
- **근거:** 7.10 runtime 선언의 기본 maxWait 2초, timeout 5초는 설계 저장 예산 3초보다 길다. 늦은 커밋 위험은 동시성/시간 초과 분석이며 DB에서 실행해 확인하지 않았다. 조건부 `status=processing` 갱신은 중복 완료는 막지만 진행 중 트랜잭션을 취소하지는 않는다.
- **제안:** 저장 기한을 repository 계약에 전달하거나 고정 저장 예산을 일관되게 적용한다. 풀/트랜잭션 획득 대기와 transaction 실행 시간을 같은 전체 기한에 포함하고, 결과를 확인하기 전 실패/완료 이벤트를 확정하지 않는다. 느린 저장·trace 삽입 실패·동시 complete/fail에서 rollback과 최종 이벤트 일치를 통합 테스트로 확인한다. 단순 Promise.race만으로 DB 취소가 보장된다고 가정하지 않는다.

### P6. Minor · optional 복합 FK를 표현할 수 없다는 전제로 출처 관계를 제거

- **위치:** 계획:1255~1259, 설계 3장의 faqs→같은 버전 청크 참조.
- **문제:** “version_id 필수 + source_chunk_id 선택이면 Prisma 복합 FK 표현 불가”라는 설명은 부정확하다. 출처는 단순 문자열로 남아 DB가 같은 버전의 실제 청크를 보장하지 못한다.
- **근거:** 공식 v7 문서는 복합 키 참조를 지원한다. optional scalar가 있는 관계는 optional relation으로 모델링하는 방향을 검토해야 하며, 필수 version_id를 NULL로 만드는 기본 SetNull은 피해야 한다. [v7 관계 문서](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations/one-to-many-relations), [v7 referential actions](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations/referential-actions) 현재 파일 로더는 정상 참조를 검사하지만 DB 직접 작성/삭제에는 해당 검사가 없다. **7.10 CLI 검증은 실행하지 않았다.**
- **제안:** optional source relation + 반대 relation과 `(versionId,sourceChunkId)` FK를 정의하고 onDelete:Restrict 등 versionId를 NULL로 만들지 않는 정책을 명시한다. 정확한 7.10 Prisma validate/generate 및 migration SQL 검증은 구현 단계에서 수행한다. 출처 FK를 의도적으로 빼려면 기술적 불가가 아닌 설계 예외로 승인하고 검증 책임을 적는다.

### P7. Minor · import 동시 실행/실패 상태 기록 계약이 불완전

- **위치:** 계획:1933~1978, 1680~1688; 설계:235.
- **문제:** 동일 hash skip 판단은 트랜잭션 밖에 있고 active 버전 singleton/직렬화가 없다. 두 CLI가 같은 새 팩을 동시에 읽으면 양쪽 모두 skip=false로 적재를 시도할 수 있다. 설계의 failed 버전을 남긴다는 설명도 한 트랜잭션 코드와 다르다.
- **근거:** 실패 시 새 버전 create까지 rollback되어 failed 행은 남지 않는다. 기존 active 데이터는 트랜잭션으로 보호되지만, 동시 active 전환의 잠금/격리 수준에 따라 경합·deadlock이나 불필요한 중복 버전이 가능하다(실제 DB 결과 미확인). 단일 앱 인스턴스와 reload single-flight는 별도 CLI의 import 동시 실행을 막지 못한다.
- **제안:** DB의 고정 활성 버전 포인터/행 잠금 등으로 import를 직렬화하고 잠금 안에서 hash를 재검사한다. 실패 버전 기록을 별도로 남길지, 아예 남기지 않는 원자 import 정책인지 정한다. 동시에 동일/다른 팩 import, 적재 중 실패, 기존 active 보존을 테스트한다. 분산 작업 큐 추가는 필요 없다.

### P8. Minor · pack 검증이 DB 제약과 FAQ 예약 선택지를 모두 보장하지 못함

- **위치:** 계획:1711~1754, 1841~1843, schema의 packName/packVersion/module.
- **문제:** manifest name/version과 chunk.module의 길이는 DB VarChar(100/50/100)와 맞춰 제한하지 않는다. FAQ id `none`을 허용하고 source_chunk_id 빈 문자열은 falsy 검사로 통과한다. context의 max_turns/assistant_max_chars도 양수만 검사하여 수정지시서 F2의 작은 문맥 상한을 보장하지 못한다.
- **근거:** 형식상 검증된 팩이 DB 적재에서 실패하거나 FAQ “정답 없음” 선택지와 충돌할 수 있다. 과도한 문맥 설정은 core가 문맥을 보존하는 대신 too_large로 종료하게 만든다. chunk/FAQ answer/applies_when/summary 상한 자체는 수정지시서 요구를 반영했다.
- **제안:** DB 컬럼 길이와 일치하는 검증, FAQ none 예약 금지, source_chunk_id를 null 또는 유효 ID로 제한한다. context 상한을 고정하거나 안전한 최대값을 정의한다. 문자 수의 UTF-16/코드포인트 기준도 명시한다. 경계 팩·빈 참조·none ID·과도한 문맥을 로더 실패 테스트로 둔다.

### P9. Minor · 필수 동시성/rollback 검증이 테스트에 없음

- **위치:** 계획:442~504, 612~699, 1656~1693, 2230~2290.
- **문제:** 예약 순번 동시성은 검사하지만 complete/fail 경합과 trace 실패 원자성은 검사하지 않는다. 지식 import는 순차 성공만 확인하며 제한기·retry 테스트도 첫 초과 요청과 재시도 중 취소/예산을 충분히 검증하지 않는다.
- **근거:** P1~P5의 오류가 현재 성공 fixture와 순차 호출 테스트로는 잡히지 않는다. health 테스트도 메서드를 직접 부르므로 실제 `/api/health` 라우팅·앱 DI/부팅은 확인하지 못한다. DB 테스트 skip은 명시적 설계지만, skip된 실행만으로 완료 조건을 충족하면 repository 안전성 증거가 없다.
- **제안:** P1~P5의 회귀 사례, trace 삽입 실패 후 processing 유지, concurrent complete/fail의 단일 종료, 동시 import, 느린 저장 rollback을 필수 통합 검증으로 추가한다. SDK fakeFetch는 signal이 이미 aborted인 경우와 listener 등록 후 취소를 모두 다룬다. 실제 테스트 DB 실행 결과를 완료 조건에 별도 기록하고, HTTP smoke에서는 앱 전체 DI와 경로를 확인한다. 본 리뷰에서는 계획 테스트를 실행하지 않았다.

### P10. Minor · policy의 limiter_ms를 무시하고 3000으로 하드코딩

- **위치:** 계획:1727, 1884, 2610~2614, 2643.
- **문제:** 팩은 limiter_ms를 검증·버전 저장하지만 JevModule은 고정 3000을 사용하고 주석은 버전마다 바꿀 필요가 없다고 한다. trace policy의 값과 실제 제한기 대기 기한이 달라질 수 있다.
- **근거:** 설계는 기한을 policy/실행 스냅샷에 포함한다. 기본값이 같은 것만으로 모든 유효 팩이 같은 동작을 갖는 것은 아니다. 또한 SnapshotService.buildSnapshot은 저장 팩의 templateVersion 호환성을 재검사하지 않고 현재 코드 상수를 붙인다.
- **제안:** 전역 고정 제한기 설정이라면 팩 필드가 같아야 한다는 검증과 trace의 실제 설정 기록을 추가하거나 요청별 대기 상한을 스냅샷에서 적용한다. 재배포 후 active 팩의 templateVersion 호환성도 init/reload 시 검사한다. core 변경이 필요한지 먼저 결정한다.

## Prisma 스키마 검증 판단

- 현재 명시된 FaqVariant→Faq 복합 관계는 fields/references 순서·타입이 맞고, ChatTurn→MessageTrace의 1:1은 turnId @unique와 역관계가 있다. enum, mysql provider, @db.Char/VarChar/Text/DateTime(3)와 Json 형태에서 **정적 검토로 확정한 문법 오류는 없다**. [v7 스키마 레퍼런스](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference)
- Faq 출처와 trace→knowledgeVersion은 관계가 아닌 scalar로 남았다. 후자는 MVP에서 지식 삭제를 하지 않는 결정과 함께 볼 수 있지만, 전자는 P6처럼 설계와 다른 무결성 보장이다.
- `.d.ts` 확인은 Prisma 스키마 파싱·DB migration·생성 클라이언트 API 검증을 대신하지 않는다. 사용자의 패키지 실행 금지에 따라 **prisma validate/generate/migrate는 실행하지 않았다**. 이후 7.10 CLI 검증, 생성 타입 전체 typecheck, MariaDB migration과 utf8mb4 저장 테스트를 완료 조건으로 남겨야 한다.

## 설계·수정지시서와 일치한 부분

core 공개 API만 사용하는 방향, 명시 API 키와 warn 로그, SDK 재시도 0, 청크당 요청, 실제 전송 FAQ ID로 파싱, estimatedInputTokens 기록, 출처 title/section ContextReader, snapshot 원자 교체·reload single-flight, 조건부 processing→completed/failed 트랜잭션은 요구를 반영했다. reserveTurn의 행 원자 increment와 같은 트랜잭션 삽입은 순번 중복 방지 방향이 맞다. 위 지적을 제외한 부분까지 미구현이라는 이유만으로 결함 처리하지 않았다.
