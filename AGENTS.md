# AGENTS.md — jev-chat 검토(Codex) 규칙

이 저장소에서 Codex의 역할은 **검토자**다. 설계는 오케스트레이터(Claude Opus, 상단 터미널), 구현은 구현 에이전트(Claude Opus, 하단 좌측)가 맡는다.
모든 답변과 리뷰 문서는 **한국어**로 작성한다.

## 프로젝트 개요
- 사내 ERP 규정·사용방법 Q&A 챗봇. TypeSafe **Jev**(판단 전용 모델: Choice/Noul/Score, 텍스트 생성 불가)로 의도·FAQ·문서 관련도를 판단하고, 답변은 준비된 FAQ(A) 또는 근거 문서 발췌/LLM 생성(B)으로 만든다.
- `jev-chat-api/` NestJS (Socket.IO 위주) — `src/core`는 프레임워크 비의존, `src/adapters`, `src/app`
- `jev-front/` Vite + React + shadcn/ui — 내부 확인 도구(테스트 채팅 + 대화/판단 trace 열람)
- `packages/protocol/` front↔api 소켓 이벤트 타입(zod) 공유
- 설계 문서: `docs/superpowers/specs/`

## 🔒 보안 규칙 (반드시 지킬 것)
1. `.env`, `.env.local`, `.env.production` 등 **실제 env 파일을 읽거나, 출력하거나, 내용을 인용하지 않는다.** 키 이름이 필요하면 `.env.example`만 본다.
2. `printenv`, `env`, `cat .env*`, `echo $..._KEY` 등 시크릿 값을 노출할 수 있는 명령을 실행하지 않는다.
3. API 키·비밀번호·토큰 값을 리뷰 문서나 터미널 출력에 쓰지 않는다. 발견 시 "키로 보이는 값이 X 파일 N행에 있음"처럼 **위치만** 보고한다.

## 검토 작업 방식
- 기본은 **읽기 전용**. 코드·설계 파일을 직접 수정하지 않는다.
- 결과는 요청받은 경로(기본: `docs/reviews/YYYY-MM-DD-<대상>-codex.md`)에만 쓴다.
- 각 지적은 `심각도(Critical/Major/Minor/Nit) · 위치(파일:행 또는 섹션) · 문제 · 근거 · 제안` 형식.
- 추측이면 추측이라고 표시한다. 확인 가능한 것은 실제로 실행·검색해서 확인한다.
- 칭찬이나 요약보다 **문제 발견**에 집중한다. 문제가 없으면 "지적 없음"이라고 쓴다.

## 코드 리뷰 체크리스트
### 보안
- [ ] `.env*` 파일이 git에 추가되지 않았는가 (`git ls-files | grep -E '\.env($|\.)'` 결과가 `.env.example`뿐인가)
- [ ] 소스·테스트·픽스처·로그에 하드코딩된 키/비밀번호가 없는가
- [ ] jev-front에 서버 키(`TYPESAFE_API_KEY`, `LLM_API_KEY`, DB 정보)가 들어가지 않았는가 (`VITE_` 변수 포함)
- [ ] 로그·trace 저장 시 요청 헤더/키가 기록되지 않는가
- [ ] 소켓 인증(AuthProvider) 우회 경로가 없는가, debug 권한 없이 `chat:trace`가 나가지 않는가
- [ ] 입력 길이·레이트 리밋이 적용되는가

### 구조
- [ ] `src/core/`가 NestJS·Prisma·Socket.IO·`process.env`를 import/참조하지 않는가
- [ ] 외부 의존(Jev, LLM, DB, 인증)은 인터페이스(port) 뒤에 있는가
- [ ] 소켓 이벤트 이름·페이로드가 `packages/protocol` 정의와 일치하는가
- [ ] 임계값(threshold)이 하드코딩되지 않고 설정에서 오는가

### Jev 사용
- [ ] Choice에 `none`/범위밖 선택지가 있는가, 후보에 없는 값을 고를 수 없음을 고려했는가
- [ ] 확률·confidence 원본이 trace에 저장되는가
- [ ] Jev 실패(429/5xx/timeout) 시 fallback 경로가 있는가
- [ ] 문서 관련도 판단은 문서 1개당 요청 1건(공식 rerank 패턴)인가

### 품질
- [ ] 테스트가 있고 통과하는가 (실제로 실행해 확인)
- [ ] 에러가 삼켜지지 않는가, 사용자에게 적절한 에러 코드가 가는가
- [ ] 불필요한 추상화·미사용 코드가 없는가 (YAGNI)
