# 스모크 후속·평가 하네스·계획 5 코드 검토

- 검토일: 2026-10-13
- 대상: `053b2cb..4ae7c94`의 요청된 코드 변경. 검토 시 HEAD는 `4ae7c94`.
- 기준: AGENTS.md, 스모크 기록, 설계 T1~T5(`45e5de7`), 계획 5(`c9106c0`).
- 결론: **A Go / B Go / C Go / 통합 push Go**. Critical·Major 지적 없음, Minor 1건. 아래 판정은 배포·holdout 합격 판정과 구별한다.

## 지적

### R1 — Minor · 확정 거부된 재전송을 다시 보내면 원래 턴 연결이 사라짐

- **위치:** `jev-front/src/lib/chat-client.ts:232`, `jev-front/src/features/chat/ChatThread.tsx:15`.
- **문제:** 실패한 서버 턴 A를 다시 보낸 로컬 턴 B가 `QUEUE_FULL` 같은 확정 거부를 받은 뒤, B의 ‘다시 보내기’를 누르면 새 턴 C에 원래 `retryOfTurnSeq`가 전달되지 않는다. C가 수락돼도 A에 ‘다시 보냄’이 표시되지 않고 버튼이 남는다. 새로고침 후 이력에서 표시가 사라지는 승인된 제한과 달리, 같은 화면에서 발생한다.
- **근거:** B에는 `turnSeq: 0`, `retryOfTurnSeq: A.turnSeq`가 남지만 `retry()`는 자신의 `turnSeq > 0`만 검사한다. 임시 테스트에서 이러한 B를 전달해 실제 `chat:send` 페이로드와 `localSend` 액션 모두에 `retryOfTurnSeq`가 없는 것을 확인했다. `retriedSeqs()`는 확정 거부된 B를 제외하므로 원본 A를 연결할 항목이 없다. 서버 수락·멱등성 위반이나 자동 중복 전송은 아니어서 Minor로 판정한다.
- **제안:** 확정 거부된 로컬 턴의 재전송에서는 기존 `retryOfTurnSeq`를 계승하고, 이미 서버에 수락된 턴은 자신의 `turnSeq`를 사용한다. ‘A 실패 → B 확정 거부 → B에서 C 재전송·수락’의 버튼/표시 테스트를 추가한다. uncertain 분기는 기존 clientMsgId 재사용을 유지한다.

## A. S1~S4 판정

| 항목 | 판정 | 확인 근거 |
|---|---|---|
| S1 지식 재로드 | 해소 | `changed=true`이며 인증 세대가 현재일 때만 FAQ·청크·config 쿼리 prefix를 무효화한다. changed=false와 늦은 이전 세대 응답은 제외하며 해당 테스트가 통과했다. |
| S2 재전송 표시 | 부분 | 일반 재전송의 로컬 연결과 terminal/hydrate 병합은 유지된다. uncertain 복구는 같은 clientMsgId를 쓰며 기존 연결 필드를 지우지 않는다. R1의 연속 확정 거부 경로만 남는다. 프로토콜에 필드가 없어 새로고침 시 연결을 복원하지 못하는 제한은 재지적하지 않는다. |
| S3 오류 문구 | 해소 | `Record<ErrorCode, string>`과 enum 순회 테스트로 전체 코드 매핑을 확인했다. 채팅 terminal 오류와 로그 화면에 적용하며 React 텍스트로 표시한다. |
| S4 시각·행 선택 | 해소 | 명시한 시간대와 브라우저 기본 시간대의 포맷 경로, 자정 표현을 검사한다. 행 클릭 외에 native button을 유지해 키보드로 선택할 수 있고 선택 상태를 aria-pressed로 제공한다. 버튼 클릭의 버블링은 동일 선택을 두 번 적용할 뿐 부수 효과가 없다. |

**A push: Go.** R1은 후속 보완 가능한 표시·연결 누락이다.

## B. 평가 하네스·Jev 수정 판정

### 리미터와 CLI 종료

- 대기열이 있을 때만 참조된 10ms 폴링 타이머가 유지된다. 빈 대기열은 타이머를 해제하고, 대기 기한 초과·abort는 대기자를 제거한다. 마지막 abort 직후에는 기존 폴링 한 번이 남을 수 있으나 영구적인 종료 방해는 아니다. 기한 검사는 기존의 `> maxWaitMs`와 폴링 단위로 수행되며 이번 변경이 무제한 대기로 바꾸지 않는다.
- 별도 Node 프로세스에서 RPS 제한 대기 후 완료, 대기 기한 초과, abort 모두 자연 종료했다. `runCli` 정상 반환 0/2는 해당 종료 코드를 유지하고, throw와 미완료 Promise는 진단과 코드 1로 종료했다.
- 임시 원장에 실제 `HoldoutLedger.reserve()` 후 미완료 Promise를 남긴 경우에도 코드 1과 진단이 나왔고, start 기록만 남으며 result 기록은 생성되지 않았다. 방어는 예약을 되돌리거나 실행 기회를 자동 복구하지 않는다. 무음 성공을 막고 불완전 실행을 명시하는 변경으로 타당하다.
- holdout 예약 이후 평가·점수 파일·원장 완료·Markdown 저장을 모두 await하며, 반환 전에 파일 작업이 남는 경로를 발견하지 못했다. 파일 저장 실패는 runCli의 코드 1 경로로 전달된다. 정상 프로세스 종료 범위에서 추가 무음 exit 0 경로는 발견하지 못했다. 강제 종료나 신호 종료까지 복구하는 설계는 아니다.
- 저장소 프로세스 회귀 테스트는 다른 생존 핸들 없이 두 번째 acquire의 완료 출력과 exit 0을 함께 검사하므로 유효하다. 로컬의 tsx 실행기 IPC 제약은 아래 실행 근거에 분리했다.

### 실패 원인과 holdout 격리

- failureCause는 판정에 사용한 호출의 종류·상태·원인·HTTP 상태만 복사한다. 원래 오류 메시지나 질문·청크 본문을 추가하지 않는다. thrown 경로도 메시지 대신 오류 이름을 기록한다.
- 정순/역순 합성 시 실패 원인들을 합치며 기존 방향별 점수 보존 구조를 유지한다. 진단 필드 추가가 provider/internal 판정 기준을 완화하지 않는다.
- holdout Markdown은 `includeItems: false`로 원인별 건수만 출력하며 항목 ID·질문·정답·참조 ID를 추가하지 않는다. 비공개 점수 파일과 공개 리포트의 구분을 유지한다. 실제 비공개 데이터는 열람하지 않았다.

### 확률 반올림과 SDK abort

- 합계 허용 오차 `max(0.01, 0.005*n)+1e-9`는 각 선택지의 소수 둘째 자리 반올림 오차 누적을 수용한다. 개별 값 0~1, 정확한 선택지 키 집합, 최고 확률 choice 검증을 유지하고 원본 확률을 재정규화하지 않는다. n=2/6의 허용·거부 경계와 0.99 회귀 테스트가 통과했다.
- fetch 래퍼는 원래 응답을 clone하기 전에 `arrayBuffer()`를 await하므로 본문 abort 거부가 SDK가 관찰하는 fetch Promise로 전달된다. 새 Response에는 이미 해제된 본문과 맞지 않는 content-length/content-encoding을 제거한다. 시도 타이머는 finally에서 해제하고 호출자 abort와 자체 timeout 구분을 유지한다.
- 로컬 HTTP 기반 회귀 테스트는 헤더만 수신/일부 본문 수신 × 호출자 abort/timeout signal을 다루는 적절한 재현이다. 이 환경에서는 소켓 테스트를 실행하지 않았고, 대신 주입한 스트림으로 헤더만/일부 본문 × 호출자 취소/시도 timeout 4건을 실행했다. 모두 예상 오류로 종료하고 unhandledRejection이 없었다. 이는 실제 네트워크 통합 재현과 동등하다고 주장하지 않는다.

**B push: Go. 지적 없음.**

## C. 계획 5·설계 T1~T5 판정

| 확인점 | 판정·근거 |
|---|---|
| 규칙 2b | A 실패 → in_scope 차단 → manipulation `>=` → scope clarify → ambiguity → FAQ 순서다. manipulation 경계 포함·범위밖 우선·고확률 FAQ 차단 테스트가 통과한다. engine의 공통 조기 결정 분기를 통해 B를 취소하고 출처 없는 clarify를 반환하므로 설계 단계 ⑤의 조기 종료에도 포함된다. |
| manipulation 파싱·trace | en/ko 템플릿의 Noul 질문을 추가하고 파서는 누락을 거부한다. dataRule 지시와 문맥 사용 제한을 유지한다. trace에 raw 응답과 파생값이 기록되며 기존 v1 trace는 프런트 optional 필드 → null → ‘—’로 표시한다. |
| 버전 라벨·호환 | TEMPLATE_VERSION v2와 팩/mini-pack manifest가 일치한다. loader와 운영 snapshot의 버전 거부 검사, templateVersionLabel의 admin·trace·평가 지문 전달을 유지한다. 이전 v1 활성 DB 팩은 재import가 필요하다는 계획과 일치한다. |
| 정책 단일 출처 | 실제 팩은 block 0.25·ambiguous 0.88·manipulation 0.7이며 버전 0.1.1이다. 운영/offline snapshot은 팩 정책을 사용한다. DEFAULT_POLICY의 종전 block/ambiguous 값 유지도 계획된 테스트 기본값이다. override는 manipulation 범위 검증·strict 키 검사·부분 병합을 적용한다. |
| BM25 tags·지식 버전 | 문서 색인에 tags를 추가하며 FAQ 색인은 그대로다. 청크 contentHash는 본문 관련 필드 기반으로 유지되고, 팩 hash에는 tags를 포함한 chunks가 들어가 변경된다. repository가 tags를 저장·복원하고 팩 hash로 새 버전을 판별하므로 검색 변경을 버전 변경으로 감지한다. tags 전용 검색과 기존 병합/동점 테스트가 통과한다. |
| T4 공격 판정 | 공격 목표 FAQ 선택뿐 아니라 그 source_chunk_id의 실제 노출도 성공으로 센다. 다른 FAQ가 같은 청크를 노출하는 경우도 명시된 설계와 일치한다. runEval의 일반·option_order 새 실행 모두 팩 기반 조회를 전달한다. 이는 지정한 근거의 노출에 대한 보수적 판정이며, 모델이 공격 지시를 인과적으로 따랐다는 증명으로 해석해서는 안 된다. |
| 판단 패널·경계 | 공용 판단 패널에 manipulation 확률을 표시한다. v1 누락 호환과 v2 표시 테스트가 통과한다. protocol/DB 스키마 변경 없이 JSON trace를 사용하며 core 경계 검사도 통과했다. |

**C push: Go. 지적 없음.** 팩 재import 및 holdout RC 실행은 운영/평가 절차로 별도 완료해야 한다.

## 실행 근거와 한계

직접 실행은 Node **22.14.0**, `/private/tmp`의 소스 스냅샷에서 수행했다. 실제 env 대신 존재하지 않는 dotenv 경로를 지정하고 TEST_DATABASE_URL을 제거했다. 소스·설계·계획과 Git을 수정하지 않았다.

- API: **42 파일 통과 / 8 파일 skip, 411 테스트 통과 / 55 skip**. DB 없는 실행으로 DB·소켓 관련 suite가 skip됐다. `hanbit-pack.spec.ts`(비공개 데이터 접근), `limiter.process.spec.ts`(tsx IPC), `sdk-transport.abort.spec.ts`(localhost listen)는 명시적으로 제외했다.
- Front: **21 파일 / 152 테스트 통과**.
- API 및 front `pnpm typecheck`: 통과.
- 추가 임시 검사: SDK 스트림 취소 **4건 통과**, ChatClient 재전송 연결 누락 재현 포함 **28건 통과**(기존 27 + 재현 1). 임시 테스트는 제품 소스에 추가하지 않았다.
- 별도 Node 프로세스: 정상 0/2, throw, 미완료 Promise, RPS 대기, 기한 초과, abort, RC 예약 후 미완료 상태를 확인했다. 저장소 tsx 실행기는 IPC listen EPERM으로 실패하므로 `node --import tsx`로 검사했다.
- 임시 실행 준비 중 루트 vitest 실행 위치 및 SWC 캐시 권한 오류는 scratch 경로/캐시 지정으로 바로잡았다. SDK 임시 fixture의 빈 질문 오류도 유효한 Noul 질문으로 수정한 뒤 위 4건을 확인했다. 이를 제품 결함으로 세지 않았다.

**오케스트레이터 제공 결과 — 독립 재실행 결과와 구별:** `4ae7c94`에서 실제 MariaDB 포함 API 53 파일/478 통과/skip 0, front 21 파일/152 통과, 전체 typecheck·build 통과. 실제 Jev 진단 336턴 invalid_response 0·크래시 0. 새 정책의 tune(en) 2회와 manipulation 0.6/0.8 비교도 사용자 보고상 합격이다. 실제 Jev 호출과 전체 build를 이번 검토에서 별도로 실행하지 않았다.

## 최종 push 의견

**A Go / B Go / C Go / 통합 `053b2cb..4ae7c94` push Go.** 발견한 R1은 Minor이며 push 차단 사유는 아니다.

통합 의견에는 요청대로 `565b81a`를 포함하지만, 그 커밋의 tune 데이터 내용은 검토 대상에서 의도적으로 제외했다. 해당 데이터의 유효성은 제공된 오케스트레이터 실행 근거에 의존하며 독립 검증했다고 주장하지 않는다. `.env*`, 실제 tune 파일(목록·크기 포함), `6fe3b83`·`5abca5d`·`565b81a`의 diff는 열람하지 않았고 실제 Jev 호출·커밋·push도 하지 않았다.
