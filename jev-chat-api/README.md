# jev-chat-api

사내 ERP 규정·사용방법 Q&A 챗봇의 NestJS API (Socket.IO 중심). 설계는 `docs/superpowers/specs/`를 본다.

## 운영

### 보관 기간과 검수 내보내기
- `RETENTION_DAYS`(기본 90일)가 지나면 세션·턴·trace·**검수(review)가 함께 삭제**된다.
- 검수 결과를 평가 항목으로 남기려면 삭제되기 전에 내보낸다.

  ```bash
  pnpm eval:export-reviews <출력 경로>   # 예: pnpm eval:export-reviews ../eval-from-reviews.jsonl
  ```

  라벨을 정할 수 없는 항목은 `<출력 경로>.needs-labeling.jsonl`로 따로 저장된다.
- 출력 파일에는 **사용자 질문 원문과 검수 메모가 들어 있다.** 저장소에 커밋하지 않는다(루트 `.gitignore`가 `eval-from-reviews*.jsonl`을 막지만, 다른 이름·경로로 내보낼 때는 직접 주의한다).

### 마이그레이션
- 운영/배포: `pnpm db:deploy` (`prisma migrate deploy`).
- 개발에서 새 마이그레이션을 만들 때(`pnpm db:migrate` = `prisma migrate dev`)는 **shadow DB가 필요하다.**
  - 전용 DB `jev_chat_shadow`를 쓴다. `infra/mariadb-init/01-test-db.sql`이 만들고 `jev` 계정에 권한을 준다(init 스크립트는 새 볼륨에서만 실행되므로, 기존 컨테이너에는 같은 SQL을 root로 직접 실행한다).
  - 접속 문자열은 `SHADOW_DATABASE_URL`로 지정하며, 비워두면 `DB_*` 값으로 조립하되 database 이름만 `jev_chat_shadow`로 바꾼다(`prisma.config.ts`).
