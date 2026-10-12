# 계획 2A DB 단계 push 전 코드 리뷰

- 검토일: 2026-10-12. 대상: `e5052ec..2e69f2e` 코드 변경과 초기 마이그레이션을 추가한 시작 커밋 `e5052ec` 자체. 확인 시 HEAD는 후속 문서 커밋 `cc060a5`이며 대상 이후 코드 차이는 없다.
- AGENTS.md, 계획 2A 완료 조건, 이전 `2026-10-08-plan2a-t3-6-codex.md` R1~R4와 대조했다. 기존 소스·설계·계획은 수정하지 않았으며 실제 `.env`는 열람하지 않았다.

## 실행 결과: 직접 검증과 오케스트레이터 검증 구분

| 검증 | 실제 결과 |
| --- | --- |
| 실행 환경 | Node **22.14.0**. Node PATH 명시. SWC 캐시를 `/private/tmp/jev-db-review-swc`로 지정. |
| 요청한 `pnpm --filter jev-chat-api test` + TEST_DATABASE_URL | **종료 1**. globalSetup의 `prisma migrate deploy`가 **P1001**로 실패하여 테스트 본문은 실행되지 않았다. 통합 테스트 통과/skip 0을 확인한 실행이 아니다. |
| 독립 TCP 접속 확인 | `127.0.0.1:3306` 접속 오류 **EPERM**. 이 실행 환경의 접속 제한이 확인됐다. MariaDB 서버가 내려갔다고 판정하지 않는다. |
| 오케스트레이터의 실제 MariaDB 실행 | **사용자 전달 결과:** TEST_DATABASE_URL을 지정한 `vitest run`에서 **25 파일 통과, 253 테스트 통과, skip 0**. Codex가 직접 관측한 실행은 아니며, 사용자 요청에 따라 DB 통합 완료의 외부 실행 증거로 반영한다. |
| DB URL 없는 API 테스트 | **종료 0, 230 통과 / 23 skip**, 22 파일 통과 / 3 파일 skip. DB 검증의 대체 증거로 사용하지 않는다. |
| 루트 `pnpm typecheck` | **종료 0**, protocol 및 API 전체 통과. 생성 Prisma 타입 포함. |
| `pnpm --filter jev-chat-api exec prisma validate` | **종료 0**, 스키마 유효. |
| 대상 diff whitespace 검사 | `git diff --check e5052ec..2e69f2e` 통과. |

첫 두 테스트 시도는 SWC 기본 캐시 권한 및 `/tmp` 심볼릭 경로 검증 문제로 시작 전에 실패했다. `/private/tmp` 캐시로 해결한 뒤 위 DB 접속 오류까지 확인했다. Prisma 명령의 dotenv 경로는 존재하지 않는 임시 경로로 지정하여 실제 env 파일을 읽지 않도록 했다. 사용자가 제공한 연결 정보는 문서에 복사하지 않았다. 실행 로그는 `/private/tmp/jev-db-review-tests.log`, `jev-db-review-unit.log`, `jev-db-review-validate.log`에 있다.

## 잔여 지적

### D1. Minor · R4 개별 토큰 검증은 해소됐지만 trace 합계의 DB 범위는 미보장

- **위치:** `jev-chat-api/src/adapters/jev/sdk-transport.ts:59`, `sdk-transport.spec.ts:142`, `src/core/engine/chat-engine.ts:236`, `prisma/schema.prisma:154`.
- **문제:** 개별 usage는 안전 정수이면서 INT 최대 이하로 제한하지만, `totalInputTokens`는 A/B 호출의 값을 제한 없이 더하여 INT 컬럼에 저장한다.
- **근거:** 새 테스트는 호출당 2147483647을 허용한다. 이 값이 두 호출에 있으면 합계는 4294967294가 되어 컬럼 범위를 벗어난다. 정상 공급자 사용에서 관측한 문제는 아니며, 코드·산술로 확인한 경계다. 실제 DB 저장 실패는 이번 접속 제한으로 재현하지 못했다.
- **제안:** 호출 수와 입력 한도를 반영한 usage 상한 또는 합계 저장 타입/범위 정책을 정하고, 개별 값은 허용되지만 합계가 초과하는 경우의 저장 계약 테스트를 추가한다. 단순 clamp로 실제 usage를 왜곡하지 않는다.

### D2. Minor · 풀의 모든 연결 설정을 입증하는 테스트가 약함

- **위치:** `jev-chat-api/src/adapters/persistence/prisma.spec.ts:26–31`.
- **문제:** 빠른 SELECT 다섯 개를 동시에 요청해도 서로 다른 다섯 물리 연결을 사용한다는 보장이 없어, 테스트 이름의 ‘모든 연결’까지 입증하지 않는다.
- **근거:** 연결 ID나 연결 점유 barrier를 검사하지 않는다. 설치된 MariaDB 타입에는 `initSql?: string | string[]`가 있으므로 옵션 자체의 API 불일치는 발견하지 않았다.
- **제안:** 동시에 유지되는 트랜잭션에서 `CONNECTION_ID()`와 설정값을 함께 읽고, 각 연결을 barrier까지 점유하여 서로 다른 연결들에 설정이 적용됐는지 검사한다.

## 이전 지적 및 SQL/락 판정

| 항목 | 이번 판정 |
| --- | --- |
| R1 저장 기한 | **수정 반영 / DB 실증 미확인.** 연결별 lock wait 2초, save_ms 최소 3000, 실제 lock 획득 barrier, holder 4.5초와 elapsed ≤3000 검사가 있다. holder가 saveMs보다 길어 이전보다 유효한 검증이다. 행 잠금 대기 제한은 모든 SQL 실행·전체 요청 시간의 보편적인 상한은 아니다. 코드도 다른 장기 쿼리는 2B 범위라고 명시한다. |
| R2 정렬·contentHash | **파일 경로 해소 / DB 왕복 미확인.** 해시 계산 전에 chunks/faqs를 JS 코드 단위 id 순으로 정규화하고 DB 결과도 같은 비교자로 다시 정렬한다. 줄 순서에 독립적인 해시 단위 테스트는 통과했다. k=1 동점 검색의 DB round-trip 테스트는 존재하지만 실행되지 않았다. |
| R3 테스트 견고화 | **취약 조건 수정 반영 / DB 실증 미확인.** strict SQL mode 전제 단언, holder barrier, 중복 clientMsgId 실패 후 counter 유지 및 다음 seq=2 검사가 추가됐다. 동일 clientMsgId의 동시 경쟁 및 서로 다른 팩 동시 import는 기존 테스트가 직접 검증하지 않는다. |
| R4 토큰 범위 | **부분.** 개별 usage의 음수·소수·안전 정수·INT 범위 검증과 상한 테스트는 통과. 합계 경계는 D1. |
| 초기 migration/FK | SQL의 복합 FAQ 출처 FK는 `(version_id, source_chunk_id)` → chunks의 동일 복합 키, DELETE/UPDATE RESTRICT다. 기타 선언된 FK는 CASCADE, 테이블은 utf8mb4다. 스키마 validate/typecheck 통과. 실제 배포·FK 거부·cascade 동작은 미확인. |
| 동시 import | 포인터 행 ON DUPLICATE KEY UPDATE → FOR UPDATE → 활성 hash 재검사 → 버전/본문 적재 및 활성 포인터 교체를 한 tx에서 수행한다. 동일 팩 3건의 단일 적재 테스트가 있으나 이번에는 DB 실행이 차단됐다. 오케스트레이터 실행 결과로 해당 동일 팩 경합 테스트의 통과를 인정한다. 모든 교착 가능성 제거를 뜻하지 않는다. |
| 동시 reserveTurn | parent 행 원자 UPDATE → current read FOR UPDATE → INSERT가 같은 tx에 있다. 5건 고유 순번 및 중복 clientMsgId의 counter rollback 검사는 오케스트레이터 실행 결과로 통과를 인정한다. |
| rollback/종료 경합 | 지식 import 실패, trace insert 실패, complete/fail 동시 종료, 잠금 지연 후 늦은 완료 방지의 테스트가 있다. Codex 직접 실행은 차단됐지만 해당 DB rollback 테스트의 통과는 오케스트레이터 실행 결과로 인정한다. |

Codex의 실제 DB 접속은 실패했으므로 서버 버전·격리 수준·설정값·잠금 시간을 직접 관측한 사실로 기록하지 않는다. 다만 오케스트레이터의 253건 통과·skip 0을 반영하면, 검토한 테스트가 단언하는 동일 팩 동시 import, 5건 동시 reserveTurn, 중복 요청 counter rollback, import/trace 실패 rollback, complete/fail 경합, 잠금 지연 시 3000ms 이내 rejection 및 늦은 완료 부재는 **외부 실행 증거로 통과**한 것으로 판정한다. 위 표의 ‘DB 실증 미확인’은 Codex 직접 실행에 대한 경계다. 서로 다른 팩 동시 import·동일 clientMsgId 동시 경쟁·모든 물리 연결의 설정·FK별 삭제 동작까지 253건 결과로 확장해 주장하지 않는다.

## 계획 2A 완료 조건 및 push 결론

- 전체 typecheck와 Prisma validate는 충족했다. DB 없이 실행하는 API 테스트도 통과했다.
- **필수 DB 통합 전부 통과·skip 0은 오케스트레이터 실행 결과로 충족**한다. 마이그레이션 적용을 수행하는 globalSetup을 포함한 실행이다. UNIQUE 및 저장/rollback 동작은 해당 테스트 범위에서 확인됐지만, FAQ 복합 FK의 RESTRICT 삭제 동작을 직접 단언하는 테스트는 없으므로 그 세부 동작은 SQL 정적 확인 범위다.
- 후속 문서 커밋에 knowledge:import 및 health smoke 완료 표시는 있지만 이번 리뷰에서 직접 재현한 증거는 아니다.

**push: Go.** 사용자 요청에 따라 오케스트레이터의 실제 DB 실행 증거와 Codex의 코드·스키마·테스트 검토를 함께 반영했다. 확정 Major는 없고 D1·D2는 Minor다. 계획 2A의 테스트·typecheck·스키마·마이그레이션 및 문서상 smoke 완료 증거를 기준으로 다음 단계 진행이 가능하다. 모든 DB 경합이나 전체 저장시간의 보편적인 상한을 증명한 승인은 아니며, FAQ 복합 FK 삭제 동작의 별도 실행 증거는 이 리뷰에 제공되지 않았다.
