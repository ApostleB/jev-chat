# 계획 2B V1 / 계획 3 Task 1–4 코드 리뷰

- 판정: **통합 push No-Go**. A(V1)는 **해소·Go**, B(평가 하네스)는 **Major 1건으로 No-Go**.
- 대상: `75b7c76`, `16ddcb5`, `8314315`, `bb81fa2`, `12663a2`, `8602dbf`. 기준: 계획 3, 설계 6장 및 `c0136be`·`1349bd0`의 계약 정정.
- 소스·계획·설계는 수정하지 않았다. 실제 `.env`, 실제 평가 데이터, 금지된 `6fe3b83`·`5abca5d`의 diff는 열지 않았다. 금지된 tune 파일의 목록·크기 확인도 하지 않았다.

## 지적

### H1 — Major · option_order 재실행이 공급자 장애가 아닌 원래 오답까지 지운다

- **위치:** `jev-chat-api/src/eval/score.ts:101`, `jev-chat-api/src/eval/run-eval.ts:140`, `jev-chat-api/src/eval/run-eval.ts:150`, `jev-chat-api/src/eval/holdout-lock.ts:115`.
- **문제:** 정순 실행이 오답이고 역순 실행만 공급자 장애인 `option_order` 항목은 합성 점수의 `failure=provider` 때문에 재실행 대상이 된다. CLI는 해당 항목의 양쪽 실행을 모두 다시 수행하고, `mergeRerun`은 합성 점수 전체를 교체한다. 재실행에서 양쪽이 정답이면 원 실행의 실제 오답·확정 행동 위반·공격 성공까지 최종 지표에서 사라질 수 있다.
- **근거:** `combineOrderScores`는 오답 플래그를 OR로, 실패 원인을 `internal > provider > none`으로 합친다. 따라서 `wrongAnswer=true`와 `failure=provider`가 함께 존재할 수 있다. 합성 데이터로 실제 함수들을 호출한 별도 재현 테스트에서 `wrongAnswer=true, attackSucceeded=true, failure=provider`가 병합 뒤 `wrongAnswer=false, attackSucceeded=false, correctAnswer=true`로 바뀜을 확인했다. 원 scores 파일은 남지만 최종 채점에서 원래 실패가 제거된다. 설계 6장 G1 및 계획의 “원 실행의 오답·내부 실패는 그대로” 계약을 충족하지 않는다. 계획 예시 코드에도 같은 누락이 있다.
- **제안:** `runs`의 정순·역순별 공급자 실패만 재실행하고, 장애가 없었던 원래 실행 점수는 유지한 뒤 다시 합성한다. 단순히 기존 `orderMismatch`를 영구 OR 하면 공급자 ERROR 때문에 생긴 불일치까지 유지되므로, 실행별 보존·재합성이 필요하다. 정순 오답+역순 provider, 정순 정답+역순 provider, 반대 방향, 내부 실패 혼합을 회귀 테스트에 추가한다.
- **테스트 공백:** `holdout-lock.spec.ts`의 병합 테스트는 provider·internal·오답을 서로 다른 ID로 배치한다. 동일한 `option_order` ID 내부의 혼합 결과를 검증하지 않아 이 결함을 통과시킨다.

## A. 계획 2B V1 재판정

**해소 / Go.** `chat.gateway.ts:56` 이후는 namespace 연결 전에도 참인 `socket.disconnected` 대신 Engine.IO의 `readyState`와 `close`를 사용한다. 정상 미들웨어 단계에서 미래 만료 타이머를 유지하며, `verify` 대기 중 전송 종료는 타이머 생성 전에 포착한다. 연결 후 disconnect와 transport close에서 정리하는 경로도 확인했다.

`chat.gateway.auth.spec.ts`는 실제 Socket.IO `Socket` 객체로 초기 `disconnected=true`를 검증하고 타이머 유지·만료·장기 재무장·인증 대기 중 종료를 검사한다. 이 테스트는 직접 실행한 단위 테스트에 포함되어 통과했다. `chat.gateway.expiry.e2e.spec.ts`의 300ms 만료 후 `io server disconnect` 및 장기 연결 유지 단언도 적절하다. 실제 네트워크 E2E 실행 결과는 아래 오케스트레이터 보고를 근거로 삼았다.

## B. 나머지 핵심 경로 확인

| 검토 영역 | 확인 결과 |
|---|---|
| en/ko 템플릿·core 경계 | 언어 선택은 인자로 전달되고 core에 env·프레임워크 의존이 추가되지 않았다. 선택지 역순은 축소된 후보에 적용하며 `none`을 유지한다. 이 변경은 한국어 정확도 자체의 검증을 대신하지 않는다. |
| 실제 templateVersion | snapshot 및 admin config가 `v1-en`/`v1-ko` 라벨을 사용한다. 팩 호환성용 `v1`과 실행 라벨의 구분은 일관된다. |
| 스키마·문맥·정책 | user/assistant 교대·쌍, 참조 존재, ANSWER 정답 라벨, required/acceptable 포함 관계를 검사한다. followup은 완료 턴으로 복원하고 core 문맥 절단을 사용한다. 정책 덮어쓰기는 허용 키와 임계값 순서를 검사한다. |
| 채점·분모·합격선 | FAQ·발췌 정답, 잘못된 참조, 확정 행동 위반, 내부/provider 구분, followup 분모 분리, 빈 집합·holdout 분모 0 거부는 설계와 부합한다. 단, 재실행 병합에는 H1이 있다. |
| 예약·지문 | 지문 파일을 `wx`로 먼저 예약한 뒤 RC를 예약한다. 같은 지문의 다른 RC 경쟁 및 재실행 1회 제한을 확인했다. src tree 해시와 원장 경로 제외는 원장 커밋만으로 재실행 지문이 바뀌는 문제를 피한다. |
| freeze·원점수 대조 | holdout SHA-256과 freeze 기록, 재실행 전 원점수 SHA-256·동일 지문을 대조한다. 실제 holdout 없이 정적으로 확인했다. 원장 단위 테스트와 임시 저장소 흐름 테스트는 직접 통과했다. |
| 항목 비노출 | CLI의 holdout Markdown은 `includeItems:false`로 항목 ID·FAQ·근거를 출력하지 않는다. 상세 scores와 provider ID 원장은 재실행용 로컬 자료로 남는다. scores 경로는 gitignore에 포함되며 계획이 허용한 예외다. 다만 로컬 파일 열람을 막는 접근 제어는 없으므로 튜닝 담당 비열람은 절차적 통제다. |
| 승인된 변경 | dotenv 로딩을 `cli.ts`로 분리한 것과 `status/result`의 RC 이름 검증 추가에 지적 없음. |
| 질문 누설 금지 | `a415792`의 팩 계약 테스트 소스는 message 및 user 턴을 FAQ variants·summary와 정규화 비교한다. holdout 비교 실패는 개수만 단언한다. 해당 데이터 테스트는 독립 작성 격리를 위해 실행하지 않았으며, 실제 데이터의 규칙 충족 여부는 직접 판정하지 않았다. |

## 실행 근거와 한계

금지된 데이터 접근을 피하려고 `c0136be`의 소스·설정만 `/private/tmp`에 추출해 Node **22.14.0**으로 실행했다. 실제 팩은 복사하지 않았고 DB 환경변수를 제거했다. `c0136be..a415792`의 API/protocol 소스 차이는 팩 계약 테스트 추가뿐임을 경로 제한 diff로 확인했다.

| 구분 | 결과 |
|---|---|
| 직접 실행: protocol build | 통과 |
| 직접 실행: API `pnpm test` | 40 파일 통과 / 8 파일 skip, **357 테스트 통과 / 55 skip**, 실패 0 |
| 직접 실행: protocol `pnpm test` | 2 파일 / **32 테스트 통과** |
| 직접 실행: API `pnpm typecheck` | 통과 |
| 직접 실행: 임시 H1 재현 테스트 | 1개 통과 — 결함의 현재 동작을 확인하는 테스트이며 수정 검증이 아님 |
| 사용자 제공: 오케스트레이터 `a415792` 실제 MariaDB 실행 | API **49 파일 / 417 통과 / skip 0**, protocol 32, front 100, typecheck·build 통과 |

샌드박스의 localhost TCP 제약으로 DB·실제 소켓 테스트를 재실행하지 않았다. 로컬 직접 실행 수치와 오케스트레이터 보고 수치를 합산하지 않는다. 실제 Jev 호출·언어별 정확도·실제 평가 데이터 검증은 수행하지 않았다.

## 최종 의견

**Critical 0건, Major 1건. A 단독 push는 Go, A+B 통합 push는 No-Go.** H1을 수정하고 혼합 실행 점수의 보존을 검증한 뒤 재판정한다. 나머지 검토 경로에서 추가 push 차단 문제는 확인하지 못했다.
