# jev-chat 설계 (초안)

- 상태: **초안 — 섹션 1~4 승인, 섹션 5~7 작성 예정**
- 작성일: 2026-10-08
- 범위: 사내 ERP 규정·사용방법 Q&A 챗봇 (jev-chat-api + jev-front)

## 0. 배경과 결정 사항

### 목적
사내 ERP의 **규정**(결재선, 마감 기한, 비용 한도 등)과 **사용방법**(화면·메뉴·기능)에 대한 직원 질문에 답하는 챗봇.

### Jev를 쓰는 이유
> LLM은 '말하기', Jev는 '판단하기'. 판단을 확률로 통제해 틀린 답을 하지 않는 사내 챗봇.

- TypeSafe **Jev**(`jev-1.13.0`)는 System One 모델로 **텍스트를 생성하지 않고** 타입이 정해진 판단과 확률(Choice / Noul / Score)만 반환한다.
- **파인튜닝 불가**(모든 고객 공통 가중치). 도메인 지식은 매 요청의 `state`, `instructions`, `criteria`로 주입한다.
- 한도: 요청당 64k 토큰(state+질문), 초당 80요청 / 100K 토큰, 텍스트 입력만. 영어가 가장 정확하며 한국어는 "not equally well" → **평가셋 검증 필수**.
- 가격: 입력 $0.042 / 1M 토큰, 출력 무료.

### 확정 결정
| # | 항목 | 결정 |
|---|---|---|
| 1 | 답변 방식 | A→B: FAQ 선택(A) 우선, 필요 시 근거 문서 기반 답변(B) |
| 2 | B의 답변 생성 | MVP는 **LLM 없이 원문 발췌형**(`ExtractiveAnswerer`). 이후 외부 LLM 구현체를 `LlmProvider`로 추가, env로 전환 |
| 3 | 실사용 위치 | 미정 → transport 어댑터 + `AuthProvider` 어댑터로 유연하게 |
| 4 | jev-front | 내부 확인 도구 (테스트 채팅 + 대화/판단 trace 열람 + 검수) |
| 5 | 스택 | NestJS(Socket.IO) / Vite + React + shadcn/ui / pnpm workspace |
| 6 | 저장소 | MariaDB. 개발은 Docker(`infra/docker-compose.yml`)지만 앱은 env로만 접속 → Docker 비의존 |
| 7 | 검색 | 앱 내 BM25(한국어 문자 bigram) 후보 → Jev Noul 재정렬. `Retriever` 인터페이스, 벡터 검색은 2단계 |
| 8 | 시크릿 | `jev-chat-api` 서버 env에만. `.env` gitignore, `.env.example` 커밋. core는 `process.env`를 직접 읽지 않음 |
| 9 | 배포 | PM2 `ecosystem.config.js` (시크릿 미포함), 소켓 서버 `instances: 1` (fork) |
| 10 | 구조 | `src/core`(프레임워크 비의존) / `src/adapters` / `src/app`(NestJS 껍데기) + `packages/protocol` 공유 |
| 11 | 원본 문서 | 아직 없음 → 가상의 ERP 샘플 데이터로 MVP 검증 |

### 저장소 구조
```
jev-chat/
├─ packages/protocol/     소켓 이벤트 타입·zod 스키마 (front/api 공유)
├─ jev-chat-api/
│  ├─ src/core/           ChatEngine, JevJudge, Retriever, Answerer, ports — NestJS/Prisma/Socket.IO/process.env 금지
│  ├─ src/adapters/       Prisma(MariaDB) 저장소, TypeSafe 클라이언트, LLM 구현체, AuthProvider 구현체
│  ├─ src/app/            NestJS: Gateway, REST, ConfigModule, DI 조립
│  └─ domain-pack/        intents.yaml, faqs.jsonl, chunks.jsonl (지식 원본, git 관리)
├─ jev-front/
├─ infra/docker-compose.yml   개발용 MariaDB
└─ docs/
```

## 1. 메시지 처리 흐름

```
[client] chat:send → [Gateway] 인증 → ChatEngine.handle()
 ① 후보 수집 (코드)
    • FAQ 검색(BM25 over faq_variants) → 후보 5개
    • 문서 검색(BM25 over chunks)       → 후보 10~12개
    • 검색어 = 현재 메시지 + 직전 사용자 메시지(가중치 낮게)
 ② Jev 호출 — 동시에 발사 (왕복 1회분 지연)
    • 요청 A 1건: intent(Choice) + faq(Choice)
    • 요청 B N건: 청크마다 relevant(Noul) 1건 (공식 rerank 패턴: 요청 간 격리)
 ③ 경로 결정 (코드, 임계값은 설정)
    ├─ intent ∈ {out_of_scope, smalltalk} 이고 P ≥ 0.7 → 고정 안내 문구     route=blocked
    ├─ faq ≠ none 이고 P(faq) ≥ 0.7                → 준비된 답변             route=faq
    ├─ relevant ≥ 0.5 인 청크 존재                  → 상위 3개로 답변         route=extractive | llm
    └─ 그 외                                       → "관련 규정을 찾지 못했습니다" + 담당부서   route=fallback
    • intent ∈ {error, account_access} 이면 답변 끝에 헬프데스크 안내 추가
 ④ 저장: chat_messages + message_traces → chat:done (+ debug면 chat:trace)
```
- MVP의 발췌형 답변: 관련도 1위 청크 원문 + 출처(title/section). 문장 단위 선택은 필요 시 추가.
- 최근 3턴을 Jev 요청 A의 `state.recent_turns`로 전달(지시대명사 해석용).

## 2. Jev 질문 설계

| ID | 유형 | 질문 | 사용처 |
|---|---|---|---|
| `intent` | Choice | 메시지 종류 (6개) | 범위밖 차단, 헬프데스크 안내, 통계 |
| `faq` | Choice | 후보 FAQ 5개 + `none` 중 정답 | A 경로 |
| `relevant` | Noul (청크당 1요청) | 이 청크가 질문에 직접 답하는가 | B 경로 근거 선별·정렬 |

### intent
```ts
{
  type: "choice",
  instructions: "Classify the employee's latest message to the company ERP help chatbot. Use `recent_turns` only to resolve references like '그럼 그건요?'.",
  criteria: {
    regulation:     "Asks about company rules/policies enforced through ERP (approval lines, closing deadlines, expense limits). Not how to click something.",
    how_to:         "Asks how to perform a task or find a screen/menu/function in the ERP.",
    error:          "Reports an ERP error message, malfunction, or unexpected behavior.",
    account_access: "Account, login, password, or permission request/problem.",
    smalltalk:      "Greetings, thanks, or chit-chat with no ERP request.",
    out_of_scope:   "A work or personal question unrelated to the ERP.",
  },
}
```

### faq
```ts
{
  type: "choice",
  instructions: "Which FAQ entry fully answers the employee's message? Choose none if no entry answers it, even if one is on a similar topic.",
  criteria: { "<faq-id>": "<faq.summary>", /* BM25 후보 5개 */ none: "No listed entry answers the message." },
}
```

### relevant
```ts
// state: { question, passage: { title, section, text } }
{
  type: "noul",
  instructions: "Does the passage contain information that directly answers the employee's question?",
  criteria: {
    true:  "The passage states the rule, procedure, or fact the question asks for.",
    false: "The passage is only on a similar topic and does not answer the question.",
  },
}
```

### 원칙
- 질문 문장은 영어, state는 한국어로 시작 → 평가셋으로 한국어 질문 문장과 비교 후 확정.
- 임계값(0.7 / 0.5)은 초기값. 설정 파일/env에서 주입, 평가셋으로 조정.
- 응답 원본(확률 분포 전체, confidence, usage, model 버전)을 trace에 저장.
- 모델은 버전 고정(`jev-1.13.0`), alias(`jev-latest`) 미사용.

## 3. 데이터 모델 (MariaDB, utf8mb4, Prisma — adapters에서만 사용)

지식 원본은 `domain-pack/` 파일(git) → `pnpm knowledge:import`로 DB 적재 → 서버 시작 시 BM25 인덱스 생성. `intents.yaml`은 DB에 넣지 않음.

```
knowledge_chunks  id(PK, "erp-approval-012") · source · title · section · text · tags(JSON) · updated_at · content_hash
faqs              id(PK) · intent · summary · answer · source_chunk_id(FK, nullable)
faq_variants      id · faq_id(FK) · text

chat_sessions     id(uuid) · user_id · channel · created_at · last_active_at
chat_messages     id · session_id(FK) · role(user|assistant) · text · route(nullable) · sources(JSON) · client_msg_id(nullable, unique per session) · created_at
message_traces    id · user_message_id(FK) · assistant_message_id(FK) · intent · intent_prob · faq_choice · faq_prob · route
                  · candidates(JSON) · jev_raw(JSON) · thresholds(JSON) · latency_ms(JSON) · jev_input_tokens · model_version · error
message_reviews   id · trace_id(FK) · verdict(correct|wrong|partial) · expected_intent · expected_faq_id · note · reviewer · created_at
```
- `message_reviews` → `eval.jsonl` 내보내기로 평가셋 확장.
- 개인정보는 `user_id`만 저장. 보관 정책은 MVP 이후.

## 4. 소켓 프로토콜 (Socket.IO `/chat`, 타입은 `packages/protocol`)

연결: `io(API_URL + "/chat", { auth: { token, protocolVersion: 1 } })` → `AuthProvider.verify(token) → { userId, roles }`. 실패 시 `connect_error: UNAUTHORIZED`.

| 방향 | 이벤트 | 페이로드 | ack/의미 |
|---|---|---|---|
| C→S | `session:start` | `{ sessionId? }` | `{ sessionId, history[] }` |
| C→S | `chat:send` | `{ sessionId, clientMsgId, text }` | `{ messageId }` |
| S→C | `chat:status` | `{ messageId, stage: judging\|retrieving\|answering }` | 진행 표시 |
| S→C | `chat:delta` | `{ messageId, text }` | LLM 스트리밍 (A·발췌형은 생략) |
| S→C | `chat:done` | `{ messageId, assistantMessageId, text, route, sources[], traceId }` | 최종 답변 |
| S→C | `chat:error` | `{ messageId, code, message, retryable }` | 실패 |
| S→C | `chat:trace` | `{ traceId, trace }` | **roles에 debug가 있을 때만** |

REST (jev-front용):
```
GET  /api/sessions?cursor=
GET  /api/sessions/:id/messages
GET  /api/traces/:id
POST /api/traces/:id/review
POST /api/admin/knowledge/reload
GET  /api/health
```
규칙: `clientMsgId` 멱등 처리, 세션당 순차 처리(큐), 메시지 최대 1,000자, 사용자당 분당 10건, 에러 코드 `UNAUTHORIZED | INVALID_INPUT | RATE_LIMITED | JEV_UNAVAILABLE | INTERNAL`.

## 5~7. (작성 예정)
- 5. jev-front 화면
- 6. 에러 처리 · 테스트 · 평가
- 7. 샘플 데이터 (domain-pack)
