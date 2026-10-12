# 계획 4 F1~F3 재판정

**F1·F2·F3 모두 해소. 통합 push(`origin/main..HEAD`) Go.**

- 확인한 기준점: `origin/main=cc060a5`, `HEAD=788a3c9`.
- 수정 대상: `789dfe1`, `d24080f`, `788a3c9`.
- 이전 누적 리뷰와 H1 해소 판정에 이번 수정 검증을 합산한 통합 의견이다. 범위 전체를 처음부터 다시 리뷰하거나 DB 통합 테스트 전체를 재실행했다는 의미는 아니다.
- 저장소 소스·설계·계획 및 Git은 변경하지 않았다. 이 문서만 작성했다. env 파일·tune 데이터·금지된 두 커밋의 diff는 열람하지 않았다.

## 재판정

| 지적 | 판정 | 확인 내용 |
|---|---|---|
| F1 — resume ack 전 이벤트 유실 | **해소** | `chat-client.ts`가 resume 동기화 요청 전에 syncStart를 dispatch한다. `turns.ts`는 같은 세션이면 기존 상태를 유지하고 다른 세션이면 초기화한다. 먼저 받은 terminal 결과는 뒤늦은 processing hydrate로 되돌아가지 않는다. |
| F2 — 실제 HTTP 취소 누락 | **해소** | ApiClient가 signal을 fetch에 전달한다. 목록·턴·trace·설정 queryFn의 signal 연결과 App의 cancelQueries/clear를 확인했다. 인증 변경은 전역 세대를 먼저 증가시키며 ReviewPage·KnowledgePage의 늦은 mutation 콜백을 차단한다. |
| F3 — retryAfterMs 무시 | **해소** | main의 QueryClient가 queryRetryOptions를 사용한다. 429/503은 30000ms 이하 대기시간을 지키며 최대 1회, 30000ms 초과는 자동 재시도하지 않는다. 그 외 4xx는 재시도하지 않고 네트워크·기타 5xx는 1회로 제한한다. 대기시간 미지정 시 기본 1000ms다. |

## 직접 재현 확인

이전 임시 재현의 입력 순서를 유지하고, 수정된 계약에 맞게 최종 단언을 바꿔 `/private/tmp`의 격리 복사본에서 실행했다. F2는 새 signal 옵션을 연결하고 F3는 실제 앱과 같은 queryRetryOptions를 사용했다.

| 추가 검사 | 결과 |
|---|---|
| 최초 resume: ack 전 done 또는 error, trace 수신 → processing 이력 ack | terminal 상태·trace 유지, 이력에서 질문 메타데이터 보충. 2개 통과 |
| 이전 세션 이벤트 배제 | 위 resume 검사에서 다른 sessionId의 이벤트가 턴을 생성하지 않음을 확인 |
| NOT_FOUND/FORBIDDEN 후 새 세션 | 임시로 받은 이전 세션 턴·trace 제거, invalid 콜백, 새 세션 준비 및 늦은 이전 이벤트 무시. 2개 통과 |
| 같은 세션 재연결 | 기존 terminal·trace가 재동기화 뒤에도 유지됨. 1개 통과 |
| QueryClient 취소 | 실제 fetch에 전달된 signal이 abort되고 캐시가 비워짐. 1개 통과 |
| 429/503 대기 경계 | 60000ms는 재시도 없음; 30000ms는 직전까지 요청 없음, 경계에서 정확히 1회만 재시도. 4개 통과 |
| ReviewPage 지연 mutation | 같은 인증에서는 toast·invalidate 각각 1회. 인증 세대 변경·unmount 뒤 완료되면 둘 다 0회. 2개 통과 |

**추가 검사 합계: 2 파일 / 12개 통과.**

F3가 구현 당시 red 확인 없이 작성됐다는 점은 별도로 보완했다. 격리 복사본에서 QueryClient 설정만 이전의 `retry:1`로 바꿔 같은 F3 검사 4개를 실행하면 **4개 모두 실패**했다. 이후 현행 설정을 원문 그대로 복원했다. 현행 코드에서는 앞서 4개 모두 통과했으므로 기존 결함을 구별하는 단언임을 확인했다.

## 기존 테스트·검증 근거

Node **22.14.0**, `788a3c9`의 프론트 소스·설정을 사용했다. 실제 env 및 평가 데이터는 격리 복사본에 포함하지 않았다.

- 직접 실행한 프론트 테스트: **19 파일 / 120개 통과**.
- 직접 실행한 프론트 typecheck·build: **통과**. 기존 500kB 초과 번들 경고는 남아 있으며 이번 수정의 기능 차단 사유로 보지 않는다.
- 기존 테스트에는 logout 시 설정 fetch abort, resume 실패 처리, reducer syncStart, retry 정책과 QueryClient 가짜 타이머 검사가 포함된다.
- 사용자 제공 오케스트레이터 실행(`788a3c9`, 실제 MariaDB): API **49 파일 / 426개 통과 / skip 0**, protocol **32개 통과**, front **19 파일 / 120개 통과**, 전체 typecheck·build 통과. 직접 실행과 구분한 외부 근거다.
- 이번에는 DB·실제 Socket.IO 네트워크·실제 브라우저 E2E를 재실행하지 않았다. 서버에 이미 도달한 mutation이 로그아웃으로 취소된다고 판정하지 않는다. 확인한 mutation 보장은 늦은 UI 콜백 차단이다.

## 지적 및 최종 의견

**새 지적 없음. 이전 F1~F3는 모두 해소됐으며 통합 push Go.**

ReviewPage 인증 세대 변경 검사와 이번 복원 경합 조합 검사는 저장소에 상시 회귀 테스트로 남기는 것을 권장한다. 전용 테스트 부재는 이번 직접 검증으로 보완했으며 별도 차단 지적으로 분류하지 않는다. 이 문서의 작성 외 저장소 파일 수정·커밋·push는 하지 않았다.
