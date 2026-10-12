# 계획 2B push 전 코드 리뷰

- 대상: `cc060a5..68e3570`의 코드 변경. 2A 후속 `13305b2`, `dec7c6b`, `1d6b4a3` 포함. 기준: AGENTS.md, 계획 2B, `da13f3e`에서 갱신한 설계 4장.
- **결론: push No-Go. 신규 Major 1건, Minor 1건. Critical 지적 없음.** 사용자 지정의 수정 중인 항목은 중복 지적에서 제외했다. 아래 Q1은 그 목록과 별개이며, DB/소켓 통합 결과가 추가되더라도 별도 회귀 검증이 필요하다.
- 검토 중 원본 작업 트리에서 후속 수정이 진행되어 `git archive 68e3570`을 `/private/tmp/jev-plan2b-review-68e3570`에 추출해 코드·테스트 기준을 고정했다. 기존 소스·계획·설계를 수정하지 않았고 실제 `.env`는 열람하지 않았다. 아래 코드 행 번호는 대상 커밋 기준이다.

## 신규 지적

### Q1. Major · UUID 표기 차이로 동일 DB 세션의 큐·슬롯·room이 분리됨

- **위치:** `packages/protocol/src/common.ts:8`; `jev-chat-api/src/app/chat/chat.service.ts:112–152`; `src/app/chat/session-queue.ts:14–48`; `src/app/chat/chat.gateway.ts:110–111,128–131`; `prisma/migrations/20261012051244_init/migration.sql:64–74`.
- **문제:** UUID 스키마는 대문자를 허용하면서 원문을 보존한다. DB 세션 ID는 `utf8mb4_unicode_ci` 비교이므로 대소문자가 달라도 같은 행에 접근하지만, 수락 잠금·슬롯·처리 체인·Socket.IO room은 요청 문자열 그대로를 키로 쓴다. 소유자가 같은 UUID의 소문자/대문자 표기를 번갈아 보내면 동일 세션의 순차 처리 및 5슬롯 제한을 우회할 수 있다. 소문자 room에 참여한 관찰자는 대문자 표기로 예약한 턴의 이벤트를 받지 못하는 경로도 생긴다.
- **근거:** 실제 `ChatSendRequestSchema`가 대문자를 그대로 반환함을 확인했다. DB의 대소문자 무시 세션 조회를 모사하여 동일 세션/순번 상태를 두 표기에 연결한 저장소와 실제 ChatService/SessionQueue를 사용했다. Judge를 barrier로 정지시키고 6건을 교대로 전송하자 **6건 모두 accepted, 슬롯 합계 6, Judge 2건 동시 시작**이었다. 같은 키만 사용하는 대조군은 여섯 번째 슬롯을 거부한다. 실제 DB·소켓 재현은 실행하지 않았으며, DB 측 동일성은 선언된 collation에 대한 정적 판단이다.
- **테스트의 빈틈:** 기존 테스트는 `randomUUID()`의 소문자 표기만 사용한다. InMemoryTurnStore는 문자열을 엄격 비교하므로 실제 DB의 ID 동등성 차이도 드러내지 않는다. DB의 순번 원자 UPDATE는 번호 중복을 막지만, 이후 엔진 처리 체인이 둘로 나뉘는 문제를 막지 않는다.
- **제안:** 모든 입력 UUID를 일관된 표기로 정규화하고, 권한 조회에서 얻은 canonical session ID를 잠금·슬롯·enqueue·해제·room·이벤트에 일관되게 사용한다. `session:start`와 `chat:send` 양쪽을 포함하고 clientMsgId의 저장/재발송 표기도 통일한다. 실제 MariaDB에서 동일 UUID 표기 혼합 시 6번째 요청 거부, 엔진 최대 동시 실행 1, 직전 완료 문맥 반영, 관찰 소켓 이벤트 수신을 검증한다. room 또는 큐 한쪽만 정규화하면 불충분하다.

### Q2. Minor · 검수 내보내기가 평가 스키마에서 거부되는 null 의도를 ready 파일에 기록

- **위치:** `jev-chat-api/src/scripts/export-reviews.ts:50–60,75`; `docs/superpowers/plans/2026-10-08-plan3-data-eval.md` Task 2의 `EvalItemSchema` (`expect.intent`).
- **문제:** 의도를 판정하지 못한 `route=error` 턴의 검수가 `correct`이면 `intent: r.expectedIntent ?? r.trace.intent`가 null이다. 이를 라벨 필요 파일이 아니라 평가 후보 파일에 기록한다. 계획 3은 intent 생략은 허용하지만 null은 허용하지 않아 해당 후보를 로드할 수 없다.
- **근거:** 대상 CLI의 실제 모듈을 임시 단위 테스트에서 실행하되 DB·파일쓰기·env 로더만 가짜로 대체했다. `verdict=correct`, `route=error`, `intent=null`, 문맥 없음의 검수 1건이 **평가 후보 1건 / 라벨 필요 0건**으로 출력되고, 계획 3에서 추출한 실제 스키마의 `expect.intent` 검증에 실패했다. DB 접속이나 실제 평가 데이터 사용은 없었다.
- **테스트의 빈틈:** 대상 커밋에는 export 결과를 평가 스키마와 대조하는 테스트가 없다. 보관 기간 테스트는 이 계약을 검증하지 않는다.
- **제안:** 의도가 없으면 선택 필드를 생략하거나 명시적인 라벨 보완 대상으로 분류한다. ready 출력 전 평가 항목의 스키마·정답 라벨 조건을 검사하고, null 의도·문맥 누락·wrong/partial 정답 라벨의 분기별 내보내기 테스트를 추가한다. CLI의 `void main` 예외 처리와는 별개 문제다.

## 실행 증거

| 검사 | 결과 |
| --- | --- |
| Node | **22.14.0**, PATH 명시. 기존 설치 의존성을 임시 스냅샷에 연결하고 protocol은 해당 스냅샷에서 빌드했다. |
| 대상 코드 `pnpm test` | **종료 0**. protocol **28 통과**, API **266 통과 / 46 skip**. 합계 **294 통과 / 46 skip**. 추가 재현 테스트를 넣기 전 결과다. |
| `pnpm typecheck` | **종료 0**, protocol/API 전체 통과. |
| `pnpm --filter jev-chat-api build` | **종료 0**. |
| 추가 재현 | Q1 재현·대조군, Q2 내보내기/스키마 검사 **3건 통과**. 여기서 통과는 문제 현상을 예상대로 관측했다는 뜻이다. |
| diff/추적 env | 대상 `git diff --check` 통과. 추적 env 파일은 `jev-chat-api/.env.example`뿐. |

pnpm이 이동한 workspace의 의존성 상태 차이를 보고 자동 설치를 시도했으나 비대화형 환경에서 중단됐다. 이후 `pnpm_config_verify_deps_before_run=false`로 자동 설치를 끄고 기존 의존성으로 검사했다. SWC 캐시는 `/private/tmp/jev-plan2b-review-swc`, dotenv 경로는 존재하지 않는 임시 경로로 지정했다. 로그는 `/private/tmp/jev-plan2b-checks.log`, 추가 재현 소스는 `/private/tmp/jev-plan2b-probes`에 보관했다.

사용자 지시에 따라 DB·소켓 접속은 시도하지 않았다. **이번 대상 커밋의 오케스트레이터 DB 통합 결과는 보고서 작성 시점에 아직 전달받지 않았다.** 이전 2A의 253건 통과를 이번 2B 통합 증거로 재사용하지 않는다.

## 계획·보안·동시성 검토 요약

- **2A D1/D2 후속:** 호출당 usage 1,000,000 상한, 합계가 INT 범위를 넘으면 nullable 컬럼 + JSON 원값/표시 저장이라는 승인된 결정이 코드·마이그레이션·테스트에 반영됐다. D2는 4개 트랜잭션이 연결을 점유한 채 barrier를 기다리고 CONNECTION_ID 고유 개수를 검사하도록 강화됐다. 해당 DB 검증의 실제 통과 여부는 외부 통합 결과 범위다.
- **인증·권한:** 고정 dev 토큰의 해시 비교, production/dev 조합 시작 거부, HTTP Bearer 및 역할 가드, trace의 debug+세션 접근 확인, room 참여 전 권한 확인, trace 수신자별 debug 필터를 확인했다. I-1을 제외한 새로운 타인 세션 권한 우회는 발견하지 못했다.
- **Origin·입력·로그:** IoAdapter의 handshake `allowRequest`와 polling CORS가 있으며 Origin 없는 클라이언트 허용은 설계와 일치한다. 메시지 스키마·8KB 애플리케이션 검사·16KB transport 제한, REST `bodyParser:false`와 JSON 8KB 설정을 확인했다. 수정 범위의 일반 HTTP/소켓 실패는 고정 오류 응답과 예외 이름 중심 로그를 사용한다. 알려진 export CLI 예외 처리 항목은 제외했다.
- **승인된 변경:** 수락 임계 구역에서 등록 순서를 확정하고 `setImmediate`로 처리 체인 등록을 미루는 방향은 단일 프로세스에서 타당하다. queued 상태는 ack 전에도 나가며 설계의 클라이언트 upsert 계약이 여전히 필요하다. `error` 객체일 때만 ApiError로 취급하는 필터와 JSON 전용 body parser도 승인된 방향과 충돌하지 않는다. 이 판단이 Q1의 서로 다른 문자열 키를 보호하지는 않는다.
- **테스트 실효성:** 소유권 거부 후 room 이벤트 미수신, 재발송의 요청 소켓 한정, debug 수신자 구분, 저장 후 done, stale 처리의 최신 결과 확인, 대기 만료 후 실행 제외를 검사하는 테스트는 계약에 대응한다. 다만 Q1의 DB/메모리 ID 동일성 경계와 Q2의 평가 출력 계약이 빠져 있다. DB/소켓 테스트 내용 검토를 실제 실행 통과로 표시하지 않았다.
- **이식성:** 이번 범위에서 core 변경은 없고, 인증·Nest·소켓·Prisma·스케줄러는 app/adapters에 있다. SessionQueue의 단일 프로세스 전제와 PM2 fork/instances:1 설정은 일치한다.

사용자가 알려준 I-1/I-2/I-3, failTurn false 통지, queueMicrotask 예외·재발송 순서, SessionQueue.run 로깅, abort 미준수 엔진, NOW(3), export main 예외, expiresAt, B5 단언, 8KB 소켓 E2E, Route 캐스트, shadow DB 권한은 별도 신규 번호로 반복하지 않았다. `68e3570`에 있는 해당 문제들이 모두 해결됐다고 판정한 것은 아니며, 진행 중인 후속 수정 커밋의 승인도 포함하지 않는다.

## push 판정

**No-Go.** Q1의 세션별 처리 순서·슬롯/room 동일성 문제를 먼저 해결해야 한다. Q2는 Minor 후속 수정 사항이다. 알려진 수정 항목과 Q1이 반영된 최종 커밋에 대해 DB/소켓 통합 결과를 결합해 재판정하는 것이 적절하다. 현재 판정의 직접 근거는 실행 환경의 제약이 아니라 새로 확인한 Major 코드 문제다.
