# jev-chat

사내 ERP 규정·사용방법 Q&A 챗봇. 모든 답변은 한국어.

## 역할 (Orca 터미널)
- 상단: 오케스트레이터 / 설계 (Claude Opus) — `docs/`의 설계·계약 문서 소유
- 하단 좌측: 구현 (Claude Opus)
- 하단 우측: 검토 (Codex) — 규칙은 `AGENTS.md`

## 구조
- `jev-chat-api/` NestJS (Socket.IO 위주). `src/core`는 NestJS·Prisma·Socket.IO·`process.env` import 금지
- `jev-front/` Vite + React + shadcn/ui — 내부 확인 도구
- `packages/protocol/` 소켓 이벤트 타입 공유 (변경은 오케스트레이터 경유)
- 설계: `docs/superpowers/specs/`, 리뷰: `docs/reviews/`

## 🔒 보안
- `.env*` 파일(`.env.example` 제외)을 읽거나 출력하지 않는다. 키 이름은 `.env.example`에서 확인.
- API 키는 `jev-chat-api` 서버 env에만. jev-front에 넣지 않는다 (`VITE_` 변수는 번들에 노출됨).
- 키·비밀번호를 코드, 테스트, 로그, 커밋 메시지에 쓰지 않는다.
