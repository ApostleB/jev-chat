# 계획 1 최종 코드 리뷰

- 검토일: 2026-10-08. 대상 `1a3e61e..c7d6ddc`의 core/protocol, `45cd4d4` 포함. C1 수정은 시작 커밋 `1a3e61e` 자체도 포함해 확인했다(Git의 `A..B`는 A를 제외함).
- AGENTS.md·수정지시서 F1~F7·현재 설계 v3 1/2장을 기준으로 검토했다. 후속 문서 커밋이 HEAD에 있으나 현재 core/protocol은 해당 구현을 검토하는 데 사용했다. 코드/설계/계획 수정·env 열람·push는 하지 않았다.
- `in_scope` 부동소수점, DEFAULT_POLICY 동결, 기한 audit, linkedController 리스너, 경계 정규식과 문맥 로딩 deadline은 **계획 2A Task 0에 이미 편입된 후속 작업**으로만 기록하며 중복 지적하지 않는다.

## 실행 결과

- 설치된 Node **22.14.0** 및 pnpm **11.22.0** 진입점/PATH를 명시해 루트 `pnpm test` 실행: 종료 0, API 122개 + protocol 23개 = **145개 통과**, 12개 테스트 파일.
- 같은 환경의 `pnpm typecheck`: 종료 0, API/protocol 모두 통과.
- API vitest.config.ts의 ESM/CJS loader 경고는 남아 있다. 계획 2A Task 1에서 처리할 것으로 이미 정해진 항목이다.
- `/tmp/jev-plan1-final-review`에서 현재 소스를 묶어 추가 재현: 이미 취소된 raceWithAbort와 ChatEngine에서 unhandledRejection 발생, clarify의 헬프데스크 안내 누락 확인. 재현은 프로세스 이벤트를 기록해 관측했고 코드 파일은 변경하지 않았다.

## C1~C7 해소 여부

| 지적 | 판정 | 위치 / 근거 |
|---|---|---|
| C1 Choice 검증 | 해소 | `judge/parse.ts:25~41`: 정확한 키 집합, 합계 오차, 최대 확률 choice, 유한수 범위 검증과 부정 테스트 반영. |
| C2 A/B 문맥 | 해소 | `judge/templates.ts` 및 spec: 문맥은 유지, A는 FAQ만 줄임, B는 초과 시 null. 축소 발생 상태에서 완성된 A/B 문맥 일치 테스트 있음. |
| C3 maxTurns=0 | 해소 | `context/context.ts`: maxTurns≤0은 빈 문맥, 0/1/큰 값 테스트 있음. |
| C4 출처 section | 해소 | `domain/types.ts`, `context/context.ts`: sources의 title/section 전달 및 후속 q2 테스트 있음. |
| C5 오류 프로토콜 | 해소 | `packages/protocol/src/events.ts`: 오류 완료의 error 필수, processing/failed 상태 검증과 부정 테스트 있음. 실제 DB/소켓 DTO 통합은 이후 계획의 검증 범위. |
| C6 추정 토큰 | 해소 | ASCII/한글/기타 계수 분리, 한자/이모지/혼합 테스트, estimatedInputTokens 감사 필드 추가. **실제 Jev 대비 추정 오차는 아직 측정하지 않았음.** |
| C7 테스트 보강 | 부분 | 병합 전체 순서·matchedBy·k 절단, summary/variant 분리, NFC, 프로토콜 부정 사례, 32k 독립 fixture는 반영. 64k 전체 질문 경계 및 새 취소 경계는 남아 있음(L3). |

## 잔여 지적

### L1. Major · 이미 취소된 raceWithAbort가 원 Promise의 rejection을 방치

- **위치:** `jev-chat-api/src/core/engine/abort.ts:3`, `engine/chat-engine.ts:118~138`.
- **문제:** signal.aborted이면 곧바로 fallback Promise를 반환하고 원 Promise에 rejection handler를 붙이지 않는다. 엔진은 취소된 상태에서도 Judge를 호출한 뒤 이 helper에 넣기 때문에 A/B rejection이 handle 결과와 별개로 처리되지 않을 수 있다.
- **근거:** 실제 재현에서 `raceWithAbort(Promise.reject(Error), 이미 abort된 signal, ...)`는 cancelled를 반환하면서 unhandledRejection을 발생시켰다. 이미 abort된 signal을 ChatEngine에 넣고 A/B가 reject하도록 하자 handle은 route=error로 끝났지만 `turn-after-abort`, `relevance-after-abort`의 unhandledRejection 두 개를 관측했다. Node의 실행 정책에 따라 프로세스 종료로 이어질 수 있다. 45cd4d4의 `p.catch`는 race 결과 Promise만 관찰하여 이 초기 분기를 보호하지 못한다.
- **제안:** 이미 abort된 경우에도 입력 Promise의 rejection을 관찰한다. 엔진에서도 취소가 확정된 시점 이후 외부 작업을 불필요하게 시작하지 않도록 한다. race helper와 엔진에 이미 취소된 입력·늦은 rejection 회귀 테스트를 추가한다. 일반 reject는 기존처럼 호출자에 전달한다. Task 0의 linkedController 누수 수정과는 별개의 결함이다.

### L2. Minor · clarify에서 헬프데스크 후처리가 적용되지 않음

- **위치:** `jev-chat-api/src/core/answer/extractive.ts:44~49,77`, `engine/chat-engine.ts:163~165`, 설계의 헬프데스크 부가 규칙.
- **문제:** showHelpdesk=true여도 clarify는 switch에서 즉시 반환하여 연락처를 붙이지 않는다. error/account_access 확률 합≥0.5이고 질문이 모호한 경우 안내가 누락된다.
- **근거:** 현재 Answerer에 clarify(ambiguous), showHelpdesk=true를 전달한 실제 결과에 MESSAGES.helpdesk가 없었다. 기존 테스트는 extractive 등 후처리에 도달하는 경로 중심이다. blocked/error도 조기 반환하지만 그 경로의 예외 정책은 명시되지 않았다.
- **제안:** 고정 문구도 공통 후처리로 보내거나 해당 route의 헬프데스크 예외를 설계에 명시한다. 높은 account_access/error 확률 + ambiguous clarify와 scope clarify를 엔진 수준에서 검사한다.

### L3. Minor · 64k 크기 경계와 취소/trace 계약 테스트가 덜 검증됨

- **위치:** `judge/templates.spec.ts` 크기 검사, `engine/chat-engine.spec.ts` 취소/trace 테스트.
- **문제:** 32k 경계는 독립 fixture로 확인하지만 state+전체 질문 64k에 대한 독립 통과/초과 테스트는 없다. 취소는 시작 후 abort만 검사하여 L1을 놓친다. 45cd4d4의 조기 FAQ trace 보존 검증은 개선됐지만 취소 원인/미완료 수치의 의미는 후속 작업과 함께 추가 검증이 필요하다.
- **근거:** 현재 테스트는 성공/부분 실패/전체 실패, FAQ 조기 중단, A reject 이후 늦은 B reject를 검증한다. 이들은 이미 abort된 입력과 다르다. 합성 미완료 audit의 attempts=0·usage 부재는 실제 공급자 청구량 0을 뜻하지 않는다.
- **제안:** 여러 질문을 가진 64k fixture를 별도로 만들고 32k 제약은 유지한 채 전체 크기만 넘기는 경우를 검사한다. 취소 전/후 완료, 이미 취소된 입력, B만 기한 초과, 실제 완료 B의 usage 보존을 통제된 barrier로 검증한다. audit 미완료 필드는 미확인/합성값임을 trace 소비자가 이해하도록 한다. 기한 원인 구분 자체의 수정은 이미 배정된 Task 0에서 수행한다.

## 경로·trace·경계 판단

- Router의 규칙 우선순위, scope/ambiguous/FAQ 확률 게이트, none, B empty/failed 구분, 최대 2청크·동점 BM25 순서와 reference 분기는 설계와 맞는다. 수치 합산 경계와 blocked 문구 정합은 이미 Task 0/설계 개정에 배정돼 있다.
- 규정 확인·다른 title 복수 조항·실제 sources 구성은 구현됐다. 헬프데스크 고정 응답 누락은 L2다.
- 45cd4d4는 조기 종료에서 모든 B 결과를 수집해 이미 완료된 B의 audit/토큰/후보 status를 보존하고 finally에서 남은 B를 정리한다. 관련 테스트가 통과했다. 반환된 usage 합산은 확인된 응답 기준이며 중단된 외부 요청의 최종 청구량을 보장하지 않는다.
- core의 현재 실제 소스에서 금지 프레임워크/SDK/process.env 참조를 발견하지 못했다. 공개 API와 NestJS 없는 standalone 테스트가 통과했다. 자동 경계 검사 강화는 이미 Task 0로 배정됐다. 추적 env 파일도 없다.

## push 의견: No-Go

**L1을 수정하고 회귀 검증하기 전에는 이번 구현의 push를 승인하지 않는 것이 타당하다.** 테스트 145개 통과만으로 이 취소 경계의 안정성이 보장되지 않는다. 이미 Task 0에 배정된 항목은 중복 차단 사유로 세지 않았다. L2/L3는 후속 수정·검증 작업으로 연결한다. 실제 push는 실행하지 않았다.
