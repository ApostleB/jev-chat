# 계획 2B 수정분 재검토

- 대상: `68e3570..edf82d8` 코드 변경. 설계 결정 `27933e2`, `da13f3e`와 대조했다. 기존 소스·설계·계획은 수정하지 않았으며 실제 `.env`는 열람하지 않았다.
- **push: No-Go.** Q1·Q2는 해소됐지만, M-7 수정에서 정상 연결의 인증 만료 타이머가 취소되는 **신규 Major 1건**을 재현했다. Critical 및 별도 신규 Minor 지적은 없다.

## 신규 회귀

### V1. Major · 인증 미들웨어의 disconnected 판정이 모든 정상 연결의 만료 타이머를 취소

- **위치:** `jev-chat-api/src/app/chat/chat.gateway.ts:56–64`, `chat.gateway.auth.spec.ts:13–18`.
- **문제:** 인증 미들웨어에서 `socket.disconnected`를 이미 종료된 연결로 해석한다. 그러나 Socket.IO는 미들웨어가 성공한 **뒤에** Socket을 connected로 바꾼다. 따라서 정상 연결도 이 시점에는 `disconnected === true`이며, 미래 `expiresAt`의 타이머를 즉시 취소하고 종료 리스너 등록도 건너뛴다. 연결 이후 만료 시각이 지나도 소켓이 유지되고, 이벤트별 만료 재검사가 없으므로 인증 유효기간 계약이 깨진다.
- **근거:** 설치된 **Socket.IO 4.8.3**의 `dist/socket.js:90`은 생성 시 `connected=false`, `:760`의 disconnected getter는 `!connected`다. `dist/namespace.js:221–244,274`는 미들웨어 성공 뒤 `_doConnect` → `_onconnect`를 실행한다. 실제 `Server`/`Socket` 객체를 생성하되 listen/TCP 없이 Gateway 미들웨어를 호출한 추가 재현에서 **전송 상태 open, 인증 성공, 만료 타이머 0개**였다. 이후 연결 완료 상태로 전환하고 기한을 넘겨도 disconnect 호출은 **0회**였다.
- **테스트의 빈틈:** 기존 Gateway 인증 테스트의 가짜 소켓은 `disconnected` 속성이 없다. 따라서 실제 연결에서는 항상 들어가는 취소 분기를 통과하지 못하고, 만료 테스트가 잘못된 전제로 통과한다. 오케스트레이터의 356건 통과와 모순되는 결과가 아니라, 기존 테스트가 놓친 수명주기 경계다.
- **제안:** 미들웨어 단계의 Socket.IO `disconnected`를 종료 판정에 쓰지 말고, Engine.IO 전송 연결의 실제 상태와 close 이벤트를 기준으로 타이머를 정리한다. 열린 전송에서 미래 만료 타이머 유지, 실제 연결 완료 후 만료 시 disconnect, verify 대기 중 close 시 정리, 긴 만료 재무장을 검증한다. 실제 Socket 객체를 사용하는 단위 검사와 짧은 expiresAt을 가진 인증 제공자의 소켓 E2E를 추가한다.

`expiresAt=0`을 이미 만료된 epoch로 거부하는 변경은 **올바르다**. 별도 재현에서도 UNAUTHORIZED였으며, 이 변경 자체를 회귀로 판정하지 않는다. 문제는 미래 만료를 가진 정상 연결의 타이머가 사라지는 것이다. 현재 DevAuthProvider는 expiresAt을 반환하지 않아 공유 dev 계정에서 바로 드러나지는 않지만, 명시된 AuthProvider 만료 계약의 보안 결함이다.

## 항목별 재판정

| 항목 | 판정 | 확인 근거 |
| --- | --- | --- |
| Q1 UUID 동일성 | **해소** | UuidSchema가 소문자로 정규화한다. authorize는 DB의 `s.id`를 돌려주고 startSession은 join/이력/응답에, send는 잠금·멱등 조회·슬롯·reserveTurn·queued 이벤트·enqueue에 같은 sid를 쓴다. 반환 TurnRow도 canonical sid로 저장되어 process/finish/expire/재발송의 키가 이어진다. Gateway room도 authz.sessionId를 사용한다. clientMsgId는 소켓 스키마에서 저장 전에 정규화한다. REST 경로도 정규화 후 조회한다. |
| Q1 테스트 | **보강 적절** | 서비스에 정규화 전 대문자를 직접 넣는 단위 테스트 및 실제 MariaDB/소켓의 혼합 표기 E2E가 추가됐다. 6번째 QUEUE_FULL, 최대 동시 실행 1, 직전 문맥, 소문자 관찰 room의 이벤트, duplicate를 검사한다. 단위 검사는 직접 통과, E2E는 전달받은 통합 결과로 통과를 인정한다. |
| Q2 내보내기 null 의도 | **해소** | buildExportItem이 유효한 의도만 넣고 없으면 필드를 생략한다. 잘못된 명시 의도는 라벨 필요로 분류한다. null/error, 문맥 누락, 정상·wrong/partial 분기 단위 검사가 통과했다. |
| I-1 admin 발송 | **해소** | canReadSession/canWriteSession 분리. startSession은 read, Gateway와 send는 모두 write를 명시하여 admin도 타인 세션에 발송할 수 없다. |
| I-2 TurnPage | **해소** | REST와 소켓의 공통 페이지 규칙, 최대 50개·오름차순·hasMore의 커서 의무가 있다. 컨트롤러가 첫 turnSeq를 nextBeforeTurnSeq로 반환하며 55턴 페이지 왕복 E2E가 추가됐다. |
| I-3 세션 keyset | **해소** | 조회 조건·정렬·nextCursor 모두 `(createdAt,id)`로 변경. lastActiveAt은 표시용이며 활동 시각 변경에 따른 누락 경계를 테스트한다. |
| M-1 failTurn false | **해소** | 처리 실패·큐 만료 모두 최신 행을 다시 읽어 completed→done, failed→error, processing→무통지한다. 저장된 상태에 맞춘 단위 테스트가 있다. |
| M-2 지연 재발송 | **해소** | defer의 setImmediate로 duplicate ack 뒤 재발송하고 콜백 예외를 로그로 격리한다. ack→replay 순서와 예외 격리 단위 검사가 통과했다. 네트워크 이벤트 순서에 대한 클라이언트 upsert 계약은 계속 필요하다. |
| M-3 무로그 예외 | **해소** | SessionQueue onError를 ChatModule 로그에 연결했고, 로그 자체의 실패가 체인을 막지 않는다. 지식 재로드 오류도 예외 이름을 기록한다. |
| M-4 abort 미준수 판단 | **해소** | 판단이 pending이어도 engineMs 후 오류 완료·후속 턴 진행·슬롯 반환, 늦은 결과 미저장/미발송을 검사하는 단위 테스트가 통과했다. |
| M-5 NOW(3) 시간대 | **해소** | 연결별 initSql에 UTC 설정을 추가했고, 서로 다른 물리 연결의 세션 time_zone 검사도 추가됐다. 실제 DB 부분은 외부 통합 증거로 판단한다. |
| M-6 export main | **해소** | 최상위 catch에서 오류 이름만 기록하고 exitCode=1. DB 연결 후의 finally disconnect도 유지한다. |
| M-7 만료 경계 | **부분 / 회귀** | undefined·비유한값·0·긴 타이머의 armExpiry 로직은 타당하고 단위 검사가 통과했다. 실제 Gateway 연결 경계는 **V1 미해소**. |
| M-8 Origin/8KB 검사 | **해소** | Origin 실패를 TransportError 및 polling HTTP 403으로 단언한다. 유효 필드+9000바이트 pad에 INVALID_INPUT, 미저장·done 없음의 소켓 E2E가 추가됐다. |
| M-9 route 캐스트 | **해소(요청 범위)** | 턴 매퍼와 trace 조회가 RouteSchema를 검사하고 CorruptRouteError를 내부 오류로 처리한다. 손상 route 단위/REST 검사가 있다. |
| shadow DB | **설정·문서 해소** | 전용 shadow DB와 DB 범위 권한, shadowDatabaseUrl 설정, 기존 볼륨 수동 적용 안내가 있다. 실제 서버의 기존 전역 권한 철회 및 migrate dev 실행 결과는 이 리뷰에서 직접 조회하지 않았다. 전달된 vitest 결과만으로 권한 철회까지 입증하지 않는다. |

authorize 호출부를 전부 검색하여 필수 mode 및 `{ok,sessionId/ack}` 결과 처리가 누락된 곳이 없음을 확인했다. 서명 변경으로 권한 실패를 성공처럼 취급하는 경로는 발견하지 못했다.

## 실행 증거와 범위

| 구분 | 결과 |
| --- | --- |
| Codex 직접 실행 | `edf82d8` 임시 스냅샷, Node **22.14.0**. protocol build 통과, 루트 `pnpm test`: protocol **32 통과**, API **303 통과 / 53 skip**(총 356건), 루트 typecheck 및 API build 모두 종료 0. |
| 오케스트레이터 실행(사용자 전달) | **edf82d8 기준**, protocol build 후 실제 MariaDB에서 API **39 파일 / 356 테스트 통과 / skip 0**, protocol **32 통과**, 루트 typecheck·build 통과. 외부 실행 증거로 반영했다. |
| Codex 추가 재현 | 네트워크 없는 실제 Socket.IO 객체로 V1 재현과 expiresAt=0 대조 **2건**. 실제 현상을 기대값으로 검사하여 둘 다 통과했다. |
| 기타 | 대상 diff whitespace 검사 통과. 실제 DB/소켓 연결 및 실제 env 열람은 하지 않았다. |

임시 스냅샷은 `/private/tmp/jev-plan2b-recheck-edf82d8`, 기본 검사 로그는 `/private/tmp/jev-plan2b-recheck-checks.log`, 재현 파일은 임시 스냅샷의 `jev-chat-api/src/app/chat/codex-expiry-probe.spec.ts`다. 기존 설치 의존성과 생성 Prisma 클라이언트를 연결했으며 protocol은 대상 소스로 다시 빌드했다. SWC 캐시·dotenv 경로는 임시 경로를 사용했다. 기본 검사 수치는 추가 재현 파일을 넣기 전 결과다.

## push 판정

**No-Go — V1 수정 필요.** 기존 Q1·Q2 및 나머지 요청된 수정은 대체로 해소됐고 실제 DB 통합 통과도 전달받았다. 그러나 정상 소켓에서 만료 타이머가 취소되는 신규 Major가 남아 있다. V1 수정 후 실제 Socket.IO 연결 수명주기를 반영한 회귀 검사와 만료 E2E를 통과하면 재판정할 수 있다.
