# 계획 1 체크포인트 1 코드 리뷰

- 검토일: 2026-10-08. HEAD `7448a0e`.
- 범위: 계획 Task 1~4의 protocol 및 core domain/retrieval/context/judge. Git의 `6a6a3f7..7448a0e`는 시작 커밋 자체를 제외하므로, 요청에 명시된 Task 1의 protocol은 `6a6a3f7`에 추가된 코드도 함께 검토했다.
- 기준: AGENTS.md, 설계 v3, `docs/superpowers/plans/2026-10-08-plan1-core-engine.md`. 작업 전부터 계획 파일에 미커밋 변경이 있었으며 보존했다. 아래 결함 일부는 계획의 예시 코드를 그대로 따른 결과이므로 계획 일치만으로 정상이라고 판단하지 않았다.
- 코드·설계·계획 수정 없음. 재현/빌드 산출물은 `/tmp`에만 생성했다. 실제 env 파일과 키를 읽거나 출력하지 않았다.

## 실제 실행 결과

| 검증 | 결과 |
|---|---|
| `pnpm test` — 저장소 요구 Node 22.14.0으로 실행 | 종료 코드 0. protocol 15개 + core 45개, 총 60개 통과(7개 테스트 파일). |
| `pnpm typecheck` — 같은 환경 | 종료 코드 0. protocol/API 모두 통과. |
| protocol tsup 빌드 — out-dir만 `/tmp`로 변경 | ESM/CJS 및 `.d.ts`/`.d.cts` 생성 성공. |
| 임시 CJS 소비자 `import = require` + TypeScript NodeNext 검사, Node 22 require | 타입 검사 통과, 런타임 `PROTOCOL_VERSION=1`. |
| 추가 경계 재현 | 잘못된 Choice 분포 수용, `maxTurns=0` 문맥 잔존, A/B 문맥 불일치, done의 retryable 제거 확인. |

기본 로그인 셸은 Node 20.11.1을 사용했고 첫 `pnpm test`·`pnpm typecheck`는 pnpm 시작 단계에서 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`으로 실패했다. 설치돼 있는 Node 22.14.0과 pnpm 11.22.0 진입점을 명시하고 PATH도 Node 22로 맞춰 다시 실행했다. 초기 실패는 테스트 결함으로 집계하지 않았다. API Vitest config의 ESM/CJS 경고는 성공 실행에서도 발생했다.

## 지적

### C1. Major · Choice 분포의 의미 검증이 없어 잘못된 판단을 정상 처리

- **위치:** `jev-chat-api/src/core/judge/parse.ts:25~31`, `parse.spec.ts:46~53`.
- **문제:** 각 값의 0~1 범위와 선택값의 허용 목록만 확인한다. 빈 분포, 합계가 1이 아닌 분포, 미지의 확률 키, 최고 확률과 다른 choice를 정상 수용한다. 빠진 값은 0으로 만들고 미지의 키는 버려 원본 의미도 바뀐다.
- **근거:** 임시 재현에서 `{}`는 모든 intent 확률 0으로 통과했고, 여섯 intent가 모두 1인 합계 6도 통과했다. `choice=regulation`, `{regulation:0.1,out_of_scope:0.9}`도 통과했다. `{regulation:0.8,weather:0.2}`는 weather를 버려 합계 0.8이 됐다. 향후 Router가 합산/임계값으로 처리하면 범위 판단과 FAQ 선택이 잘못될 수 있다(영향은 추론; Router는 이번 범위 밖). 공식 Choice는 모든 옵션의 확률, 합계 1, 최고 확률 옵션 선택을 정의한다. [Choice 공식 문서](https://docs.typesafe.ai/primitives/choice)
- **제안:** 실제 전송 옵션과 분포 키의 일치, 합계의 부동소수점 허용 오차, choice의 최대 확률 일치(동점 허용)를 검증하고 불일치 시 `JevResponseError`로 거부한다. 공급자가 sparse 분포를 허용한다는 근거가 없다면 누락을 0으로 보정하지 않는다. 계획에 들어 있는 “빠진 intent는 0” 테스트도 수정 대상이다. 합계 0/과다, 알 수 없는 키, 최고값 불일치, 경계 0/1, NaN/Infinity를 회귀 사례로 둔다.

### C2. Major · 요청별 크기 축소가 질문의 문맥을 서로 다르게 만듦

- **위치:** `jev-chat-api/src/core/judge/templates.ts:104~128`, `templates.spec.ts:84~99`.
- **문제:** A와 B는 독립적으로 한도를 검사하고 최근 문맥을 제거한다. 동일한 후속 질문이 A에서는 참조 대상 없는 문장, B에서는 이전 질문을 가리키는 문장으로 평가될 수 있다. 문맥이 바뀌었다는 정보도 별도로 반환하지 않는다.
- **근거:** 동일한 recentTurns에 1,000자 수준의 이전 user 문장, A에 한글 21,000자의 FAQ 답, B에 작은 청크를 넣자 A의 recent_turns는 0개, B는 1개로 재현됐다. 입력 메시지는 짧아도 지식 원문 때문에 발생한다. 계획 Task 7의 문맥 전달 테스트는 Judge 포트에 전달된 문맥만 비교하므로 빌더가 실제 전송 직전에 제거하는 문맥 차이는 잡지 못한다. 이는 모델 오답을 확인한 결과가 아닌, 서로 다른 판단 입력을 확인한 결과다.
- **제안:** 한 턴에 사용할 문맥 축소 정책을 공통으로 결정하고 A/B에 동일하게 적용하거나, 문맥을 유지할 수 없는 후보는 제외/too_large로 종료한다. 참조형 질문의 필수 문맥을 버려야 하면 clarify로 보류할 수 있게 표시한다. 실제 완성된 A와 모든 B의 recent_turns를 비교하는 계약 테스트를 추가한다. 축소한 FAQ 목록도 파서에는 실제 전송한 목록을 넘기도록 어댑터 계약에 명시한다.

### C3. Minor · maxTurns=0에서 전체 이력이 포함됨

- **위치:** `jev-chat-api/src/core/context/context.ts:25~30`, `context.spec.ts:6~32`.
- **문제:** `slice(-0)`은 `slice(0)`이므로 문맥 사용을 0턴으로 설정하면 오히려 전달받은 모든 턴을 포함한다.
- **근거:** 완료 턴 한 개와 maxTurns=0으로 실행한 결과 turnSeqs가 `[1]`이었다. 기본값 2에서는 발생하지 않는다. 음수·소수의 설정도 현재 검증하지 않는다.
- **제안:** 0이면 빈 문맥을 반환하거나 설정 스키마에서 0을 명시적으로 금지한다. 0/1/전체보다 큰 값과 설정 오류를 테스트한다. assistantMaxChars에 생략 부호를 포함하는지도 정한다.

### C4. Minor · 검색 문맥에 출처 section을 전달할 수 없음

- **위치:** `jev-chat-api/src/core/domain/types.ts:60~65`, `context/context.ts:38~46`, 설계:110.
- **문제:** 설계 q2는 직전 답의 출처 title/section을 포함하지만 CompletedTurn과 ConversationContext에는 sourceTitles만 있어 section이 사라진다.
- **근거:** 같은 “전자결재 규정” 안의 “상신 취소” 절을 가리키는 후속 질문은 title만으로 해당 절을 검색하지 못할 수 있다(검색 품질 영향은 추론). Task 3의 계획과 테스트도 제목만 요구하여 설계와의 차이를 그대로 허용한다.
- **제안:** source title/section을 구조적으로 전달하거나 section을 포함한 검색 텍스트임을 계약에 명시한다. 같은 title의 서로 다른 section 중 직전 출처 절을 찾는 후속 질문 테스트를 둔다.

### C5. Minor · route=error 완료 이벤트의 재시도 정보를 스키마가 제거

- **위치:** `packages/protocol/src/events.ts:69~75`, `events.ts:17~28`, 설계:149 및 294.
- **문제:** 설계는 장애 안내를 completed + chat:done으로 보내고 retryable을 표시하지만 ChatDoneEventSchema/TurnSchema에는 완료된 오류 안내의 재시도 계약이 없다. 타입을 따르거나 zod로 파싱하면 해당 정보를 전달할 수 없다.
- **근거:** `route=error, retryable=true, code=JEV_UNAVAILABLE` done을 실제 parse했을 때 retryable/code가 결과에서 제거됐다. 따라서 front가 서버의 재시도 가능 여부를 표시하려면 route만 보고 추정해야 한다. 설계 이벤트 표와 Task 1 예시에도 필드가 없어 상위 계약의 누락이 내려온 경우다.
- **제안:** route=error의 error/retryable 메타데이터와 재연결 Turn 표현을 함께 정한다. 정상 done/오류 done/재연결 오류 턴에 대한 parse 및 타입 테스트를 추가한다. Gateway/front가 아직 없으므로 현재 UI 장애를 확인한 것은 아니다.

### C6. Minor · 토큰 추정에서 모든 비한글을 영문처럼 취급

- **위치:** `jev-chat-api/src/core/judge/templates.ts:29~48`, `templates.spec.ts:76~104`.
- **문제:** 한자·이모지·그 외 문자에 모두 3코드포인트당 1토큰을 적용하면서 “보수적” 추정이라고 명명한다. 이 값은 요청 크기와 계획 2의 전역 토큰 예산에 사용될 예정이어서 작은 문자 수만으로 안전성을 보장할 수 없다.
- **근거:** 1,000자의 한글은 1,500, 한자와 이모지는 각각 334로 계산됐다. **Jev 실제 토큰 수와 비교하지 않았으므로 실제 과소추정 배율은 미확인**이다. 공식 한도는 모델 토큰 기준이며 추정 함수가 실제 한도를 보장한다는 근거는 없다. [Models 공식 문서](https://docs.typesafe.ai/models)
- **제안:** ASCII/한글/그 외 문자의 보수적 계수를 분리하고 사용량 응답과의 오차를 기록한다. 정확한 tokenizer가 없으면 충분한 안전 여유를 두고 서버의 크기 거절을 too_large로 처리한다. 다양한 CJK·이모지·숫자·JSON 입력과 한도 주변 테스트를 추가한다. 현재는 정확도 미측정의 예방적 Minor이며, 실제 한도/예산 초과가 확인되면 상향한다.

### C7. Minor · 통과 테스트가 병합·축소·프로토콜 상태의 계약을 충분히 구분하지 못함

- **위치:** `retrieval/retriever.spec.ts:18~42`, `judge/templates.spec.ts:84~104`, `packages/protocol/src/protocol.spec.ts:67~94`.
- **문제:** 병합은 첫 결과·중복·순번만 확인하고 전체 q1/q2 교차 순서를 비교하지 않는다. summary/variants 검색도 양쪽 단어가 함께 있는 질의라 한 필드를 빼도 결함을 놓칠 수 있다. 크기 검사는 구현의 checkRequestSize를 다시 호출하는 데 치우치고 양쪽 한도·전송 후보 동기화를 독립 검증하지 않는다.
- **근거:** q1 결과를 전부 넣은 후 q2를 붙이는 잘못된 병합도 현재의 첫 결과/중복 제거/연속 rank 검사만으로는 구분되지 않을 수 있다(변이 실행은 하지 않은 테스트 분석). failed 턴에 error가 없는 값과 hasMore=true인데 다음 cursor가 없는 값은 스키마에서 실제 통과했다. 그 상태의 복구 불가능성을 거부하는 테스트는 없다.
- **제안:** q1 `[a,b,c]`, q2 `[a,d,b]`에서 전체 순서 `[a,b,d,c]`와 matchedBy·k 절단을 검증한다. summary-only/variant-only 질의를 분리하고 NFC·k=0도 추가한다. 크기는 알려진 독립 계산 fixture로 32k/64k의 이하·동일·초과를 따로 확인한다. Turn/페이지의 상태별 필수 필드와 hasMore→cursor 관계를 스키마 또는 app 계약 중 한 곳에서 보장하고 테스트한다.

## 구현자 자체 보고 6건의 판정

| 항목 | 심각도 | 위치 | 문제 · 근거 · 제안 |
|---|---|---|---|
| retriever 두 번째 matchedBy 루프 | Nit | `retrieval/retriever.ts:65~72` | 첫 루프가 maxLen 전체를 이미 순회하므로 두 번째 루프의 push 조건은 참이 되지 않는다. 결과 정확성에는 영향 없이 중복 순회만 한다. 루프/주석 제거 권고. |
| buildContext maxTurns=0 | Minor | `context/context.ts:30` | 실제 전체 이력 포함 재현. C3. |
| parser INTENT_IDS 고정 vs intents 주입 | Minor(계약 검증 누락) | `judge/parse.ts:47`, `templates.ts:51~55`, `domain/types.ts:30~32` | **MVP 의도 ID는 6개 고정이고 주입은 criteria 설명 변경이므로 고정 ID 자체는 버그가 아니다.** 다만 IntentDef[]는 누락/중복을 허용해 실제 전송 선택지와 파서 허용 목록이 달라질 수 있다. import/config 경계에서 정확한 6개 ID 집합을 검증하고, 파싱은 실제 전송 옵션과 연결한다. 임의 의도 확장용 generic화는 불필요. |
| estimateTokens 한자·이모지 | Minor | `judge/templates.ts:31~40` | 1,000자를 각각 334로 산정하는 사실은 확인, 실제 Jev 대비 과소추정은 미측정. C6. |
| protocol exports CJS 타입 경로 | Nit(현재 환경 실패 없음) | `packages/protocol/package.json:9~14` | 빌드는 index.d.cts도 생성하지만 require도 최상위 types의 index.d.ts로 해석된다. 임시 Node 22/TS 6 NodeNext CJS 소비자는 타입·런타임 모두 통과했다. import/require 각각에 대응 types를 배치하고 소비자 계약 테스트로 명시성을 높이는 정도다. 현재 CJS 사용 불가라는 주장은 근거 없음. |
| vitest.config.ts ESM/CJS 경고 | Nit | `jev-chat-api/vitest.config.ts:1`, `jev-chat-api/package.json` | 성공한 테스트 실행에서 경고 재현. 현재 테스트 실패는 아니고 미래 native config loader 호환 안내다. config만 `.mts`로 명시하는 방식 등으로 정리한다. 경고 제거를 위해 API 전체 모듈 방식을 무조건 변경하지 않는다. |

## AGENTS.md 체크리스트 결과와 범위 제한

- **core 경계:** 실제 소스 검색에서 NestJS·Prisma·Socket.IO·TypeSafe SDK·process.env 참조 없음. 런타임 외부 import는 파서의 zod이며 금지 프레임워크가 아니다. 경계 자동 테스트와 standalone 엔진은 Task 8 범위이므로 지금 미구현을 이번 결함으로 세지 않았다.
- **시크릿:** `git ls-files '*.env' '*.env.*'` 결과 없음. 지정 소스/테스트에서 관련 문자열을 위치 중심으로 확인했고 발견한 password 표기는 의도 설명이다. 키/비밀번호 하드코딩으로 확인된 값은 없다. 전체 저장소 보안 감사로 확대하지 않았다.
- **Jev:** FAQ none, 고정 모델, DATA_RULE와 청크별 B 요청 빌더는 있음. 실제 HTTP·재시도·한도·실행 trace·Socket 인증/권한은 다음 계획/Task에서 검증해야 한다. 파서가 throws하는 것은 Task 4 계약이며, 어댑터가 invalid_response 결과로 변환하는 처리는 아직 범위 밖이다.
- **프로토콜:** 문자열 trim·코드포인트·uuid·route 7개·8KB helper는 있음. helper를 실제 수신 payload에 적용하는지, 레이트 리밋·debug 권한을 지키는지는 Gateway 구현 전이라 확인할 수 없다. trace의 unknown 값이 JSON만 포함한다는 보장도 최종 trace/app 계약에서 확인해야 한다.
- **검색:** 확인한 기본 BM25 수식·양수 결과 필터·동점 입력 순서·교차 병합 구현에는 별도 계산 오류 지적 없음. 한글 NFC+bigram 동작도 확인했다. 한 글자 부분어·한자 검색 미지원은 현재 토크나이저의 범위이며 도메인 평가로 recall을 확인할 항목이다.

**체크포인트 의견:** 테스트/타입 검사 통과와 별개로 C1·C2의 Major를 해소하고 회귀 테스트를 추가한 뒤 승인하는 것이 타당하다. 그 밖의 Minor는 다음 Task/어댑터 계약에서 놓치지 않도록 계획에 연결한다.
