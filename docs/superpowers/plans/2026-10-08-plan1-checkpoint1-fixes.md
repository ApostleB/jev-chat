# 계획 1 체크포인트 1 수정 지시 (Task 4.5)

> 근거: `docs/reviews/2026-10-08-plan1-checkpoint1-codex.md` (C1~C7). Task 5로 넘어가기 전에 이 문서를 하나의 Task로 처리한다. TDD(실패 테스트 → 구현 → 통과) 순서, 수정 묶음별로 커밋.
> 계획 1의 Global Constraints를 그대로 따른다. 이 문서의 결정이 계획 1 본문과 충돌하면 **이 문서가 우선**한다(계획 1 Task 5~8 본문은 이미 이 결정에 맞게 갱신됨).

## F1. Choice 응답 엄격 검증 (C1, Major)

`jev-chat-api/src/core/judge/parse.ts`의 `toChoice`를 다음 규칙으로 바꾼다. 위반 시 `JevResponseError`.
1. `probabilities`의 키 집합 = 실제로 보낸 선택지 집합(`allowed`)과 **정확히 일치**(누락·추가 키 모두 거부). 누락을 0으로 채우지 않는다.
2. 모든 값은 유한수이고 0~1 (`Number.isFinite`).
3. 합계 `|Σ − 1| ≤ 0.01`.
4. `choice`는 최대 확률 옵션이어야 한다(최댓값과의 차이 ≤ 1e-6이면 동점 허용).
5. `confidence`는 0~1 유한수.

```ts
const SUM_TOLERANCE = 0.01;
const TIE_EPSILON = 1e-6;

function toChoice<T extends string>(raw: unknown, allowed: readonly T[], name: string): ChoiceResult<T> {
  const parsed = ChoiceAnswer.safeParse(raw);
  if (!parsed.success) fail(`${name}: choice 형식 아님`);
  const { choice, confidence, probabilities } = parsed.data;
  const keys = Object.keys(probabilities);
  const allowedSet = new Set<string>(allowed);
  if (keys.length !== allowedSet.size || !keys.every((k) => allowedSet.has(k))) fail(`${name}: 확률 키가 보낸 선택지와 다름`);
  if (!allowedSet.has(choice)) fail(`${name}: 허용되지 않은 선택지 ${choice}`);
  const values = keys.map((k) => probabilities[k]!);
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) fail(`${name}: 확률 합계 ${sum}`);
  const max = Math.max(...values);
  if (max - probabilities[choice]! > TIE_EPSILON) fail(`${name}: choice가 최고 확률이 아님`);
  return { choice: choice as T, confidence, probabilities: probabilities as Record<T, number> };
}
```
`ChoiceAnswer`/`NoulAnswer`의 `Prob`는 `z.number().min(0).max(1)` 유지(zod는 NaN·Infinity를 이미 거부하지만 테스트로 확인).

**테스트 교체/추가** (`parse.spec.ts`):
- 삭제: "확률에 빠진 intent는 0으로 채운다".
- 추가(모두 `JevResponseError`): intent 확률 키 누락(5개만), 모르는 키 추가(`weather`), 합계 0.8, 합계 6, choice가 최고 확률이 아님(`choice=regulation`, regulation 0.1 / out_of_scope 0.9), NaN, Infinity, faq 확률에 보내지 않은 FAQ id 포함.
- 추가(통과): 합계 0.995, 동점(두 옵션 0.5/0.5에서 둘 중 어느 쪽 choice든 허용), 경계값 0과 1.
- 기존 성공 픽스처들은 합계 1·키 완전 일치가 되도록 수정(예: faq `{ "faq-a": 0.85, none: 0.15 }`는 그대로 OK).

## F2. A/B 문맥 일치 — 대화 문맥은 절대 축소하지 않는다 (C2, Major)

`jev-chat-api/src/core/judge/templates.ts`:
- `buildTurnRequest`: 한도 초과 시 **FAQ 후보만** 뒤에서부터 줄인다. `recent_turns`는 항상 원본 그대로. FAQ 0개로도 초과하면 `null`.
- `buildRelevanceRequest`: `recent_turns`를 제거하는 대체 경로를 삭제한다. 초과하면 `null`.
- 근거: 문맥은 최대 2턴(user 1000자 + assistant 300자 ×2)으로 상한이 있고, 청크·FAQ 길이는 import에서 상한을 건다(계획 2A의 pack-schema가 반영: chunk text ≤ 4000자, faq answer ≤ 2000자, applies_when ≤ 1000자, summary ≤ 500자).

```ts
export function buildTurnRequest(req: TurnJudgeRequest): JevRequest | null {
  for (let n = req.faqCandidates.length; n >= 0; n--) {
    const candidate = assembleTurn(req, req.recentTurns, n);
    if (checkRequestSize(candidate).ok) return candidate;
  }
  return null;
}

export function buildRelevanceRequest(req: RelevanceRequest): JevRequest | null {
  const r: JevRequest = {
    model: JEV_MODEL,
    state: {
      employee_message: req.message,
      recent_turns: req.recentTurns,
      passage: { title: req.chunk.title, section: req.chunk.section, text: req.chunk.text },
    },
    questions: { relevant: RELEVANT_QUESTION },
  };
  return checkRequestSize(r).ok ? r : null;
}
```

**테스트** (`templates.spec.ts`):
- 기존 "한도를 넘으면 recent_turns를 먼저 비우고…" 테스트를 교체: 큰 FAQ 답변 2개 + 짧은 문맥 → 결과의 `state.recent_turns`가 **입력과 동일**하고 FAQ 후보만 줄어듦.
- 신규 계약 테스트 "A와 모든 B는 같은 recent_turns를 보낸다": 같은 `recentTurns`, 큰 FAQ 답변(축소 유발), 작은 청크 2개로 A·B를 빌드해 `A.state.recent_turns`와 각 `B.state.recent_turns`가 `toEqual`.
- 신규: 문맥을 유지하면 B가 한도를 넘는 경우(거대 청크) → `null`(문맥 제거 대체 경로 없음).
- 신규: 독립 계산 fixture로 32k/64k 경계 — `estimateTokens`로 정확히 32000 / 32001이 되는 state를 만들어 이하·초과 판정을 따로 확인.

## F3. maxTurns ≤ 0이면 빈 문맥 (C3)

`context.ts`의 `buildContext`: `const recent = opts.maxTurns <= 0 ? [] : turns.slice(-opts.maxTurns);`
테스트: maxTurns 0 → 빈 문맥, 1 → 마지막 1턴, 턴 수보다 큰 값 → 전체. 절단 시 `…`(U+2026)를 붙이는 현재 동작을 명시적으로 유지(10자 + "…").

## F4. 출처를 title + section으로 전달 (C4)

`jev-chat-api/src/core/domain/types.ts`:
```ts
export interface SourceLabel {
  title: string;
  section: string;
}
export interface CompletedTurn {
  turnSeq: number;
  userText: string;
  assistantText: string;
  sources: SourceLabel[];   // 기존 sourceTitles 대체
}
```
`context.ts`: `ConversationContext.previousSourceTitles` → `previousSources: SourceLabel[]`. q2 = `[message, previousUserText, ...previousSources.map((s) => `${s.title} ${s.section}`)].join(" ")`.
테스트: context.spec의 기대값 갱신 + "같은 title의 다른 section 중 직전 출처 절이 q2에 들어간다" 케이스 추가(`{ title: "전자결재 규정", section: "상신 취소" }` → q2에 "전자결재 규정 상신 취소" 포함). `core/index.ts`에서 `SourceLabel` 재수출(Task 8에서 `export * from "./domain/types"`로 자동 포함).

## F5. 프로토콜: 장애 응답의 재시도 정보와 상태별 필수 필드 (C5, C7 일부)

`packages/protocol/src/events.ts`:
- `TurnErrorSchema = z.object({ code: ErrorCodeSchema, retryable: z.boolean() })`를 만들고 `TurnSchema.error`와 `ChatDoneEventSchema.error`(optional)에 사용.
- `ChatDoneEventSchema`에 `.superRefine`: `route === "error"`이면 `error` 필수, 아니면 `error` 금지.
- `TurnSchema`에 `.superRefine`:
  - `status === "completed"` → `assistantText`, `route` 필수. `route === "error"`면 `error` 필수.
  - `status === "failed"` → `error` 필수, `assistantText` 금지.
  - `status === "processing"` → `assistantText`, `route`, `error` 금지.
- `SessionStartResponseSchema`에 `.superRefine`: `hasMore === true`면 `nextBeforeTurnSeq` 필수.
- 테스트: 정상 done / 오류 done(error 포함 통과, 누락 거부) / 정상 done에 error 있으면 거부 / failed 턴 error 누락 거부 / processing 턴에 assistantText 있으면 거부 / hasMore=true인데 cursor 없으면 거부.

설계 문서 4장 이벤트 표는 오케스트레이터가 갱신한다(구현자는 docs 수정 금지).

## F6. 토큰 추정 계수 분리 + 추정치 기록 (C6)

`templates.ts`의 `estimateTokens`:
```ts
/** 보수적 토큰 추정: ASCII 3자 = 1토큰, 한글 1자 = 1.5토큰, 그 외(한자·이모지·기타) 1자 = 2토큰 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let ascii = 0;
  let hangul = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else if (HANGUL.test(ch)) hangul++;
    else other++;
  }
  return Math.ceil(ascii / 3 + hangul * 1.5 + other * 2);
}
```
`judge/ports.ts`의 `JevCallAudit`에 `estimatedInputTokens?: number` 추가(실제 usage와의 오차를 trace로 비교하기 위함 — 계획 2A의 TypesafeJudge가 채운다).
테스트: 한자 1000자 = 2000, 이모지 1000자 = 2000, ASCII 300자 = 100, 혼합 문자열 1건.

## F7. 테스트 보강·정리 (C7, Nit)

- `retriever.spec.ts`: 병합 순서 계약 — 인덱스를 직접 만든 픽스처로 q1 결과 `[a,b,c]`, q2 결과 `[a,d,b]`가 되게 구성하고 전체 순서 `[a,b,d,c]`, `matchedBy`(a: q1·q2, b: q1·q2, d: q2, c: q1), k=3 절단 `[a,b,d]`를 검증. (BM25 점수로 순서를 맞추기 어렵다면 `Bm25Retriever`의 병합 로직을 `mergeRanked(lists: Bm25Hit[][], k: number)` 순수 함수로 분리해 직접 테스트한다.)
- `retriever.spec.ts`: summary에만 있는 단어로 검색 / variants에만 있는 단어로 검색을 각각 분리. NFC(분해형 "한"=`한`) 질의가 조합형 문서와 매칭. `k=0` → 빈 배열.
- `retriever.ts`: 두 번째 matchedBy 루프(죽은 코드) 삭제.
- `packages/protocol/package.json` exports를 조건별 types로:
```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```
  빌드 후 `dist/index.d.cts` 생성 확인.

## 완료 조건
- `pnpm test`, `pnpm typecheck`, `pnpm --filter @jev-chat/protocol build` 통과
- 커밋 메시지 예: `fix(core): 체크포인트1 리뷰 반영 - Choice 분포 엄격 검증(C1)` 등 묶음별, 각 커밋 본문에 해당 C번호
- 끝나면 Task 5부터 계획 1을 이어서 진행
