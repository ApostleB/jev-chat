# 계획 2B 구현 전 검토

- 대상: `docs/superpowers/plans/2026-10-08-plan2b-api-transport.md`, 2026-10-08. 이하 `계획:행`은 이 파일 위치다.
- 기준: AGENTS.md, 설계 v3의 수락·종료·프로토콜·권한 계약, 개정 계획 2A의 TurnRepository/SnapshotService 인터페이스.
- 의견: **No-Go.** 아래 Major 6건을 계획에 반영하고, 정확한 Socket.IO 4.8.3 타입·실제 Gateway 계약 검증을 구현 완료 조건으로 유지해야 한다.
- 검토는 계획 코드에 대한 분석이다. 프로젝트 설치·코드/설계/계획 수정·실제 env 열람·DB 접속·Nest/Socket.IO 런타임 실행은 하지 않았다. 위험 시나리오는 별도 표시하지 않는 한 계획에서 도출한 추론이며 실제 장애/침해를 확인한 것이 아니다.
- 검토 중 다른 작업의 커밋 `77f0bc4`로 계획 2A Task 0와 설계의 blocked 판정 문구가 갱신됐다. 추가 변경도 읽어 확인했으며, TurnRepository/ContextReader의 이번 비교 대상 계약과 아래 판정에는 영향이 없다. 본 검토가 수정한 것은 이 리뷰 파일뿐이다.

## 타입/API 및 검증 범위

- `/tmp/jev-plan2b-review/types`에 기존 스크래치 tarball의 `@nestjs/websockets@12.1.2`, `@nestjs/platform-socket.io@12.1.2` 타입 선언과 package.json만 추출했다. `@nestjs/common@12.1.2` 선언은 앞선 리뷰에서 확보한 `/tmp/jev-plan2a-review/types`를 참고했다. 대상 패키지 코드는 실행하지 않았다.
- platform-socket.io package.json의 socket.io 의존성이 **4.8.3**인 것은 확인했다. IoAdapter.create는 Server 또는 Namespace를 반환하고 createIOServer는 Server를 반환한다. OnGatewayInit은 generic afterInit(server) 계약이다. 계획의 override·Gateway decorator·반환 ack 접근에서 확인된 API 이름 오류는 없다. 다만 선언만으로 실제 namespace middleware 호출·ack 전달까지 검증한 것은 아니다.
- **socket.io@4.8.3 npm pack은 ENOTFOUND registry.npmjs.org로 실패했다.** 정확한 버전의 로컬 tarball도 없었고 공개 CDN 조회도 실패했다. 기존 4.8.4 server/client 선언에서 Namespace.use, join, fetchSockets, emitWithAck, timeout 형태는 보충 확인했으나 **4.8.3 확인을 대신하지 않는다**. 정확한 버전 검증은 미완료다. 관련 로컬 패키지를 프로젝트에 설치하지 않았다.
- Node 22.14.0으로 계획의 SessionQueue만 스크래치에서 컴파일·실행했다. 같은 세션 withLock 순서 `[a-start,a-end,b]`, run의 앞 작업 대기 후 다음 작업 진행을 확인했다. 계획의 통합/E2E 테스트는 실행하지 않았다.

## 지적

### B1. Major · 저장소/인증 예외가 소켓 실패 ack로 변환되지 않음

- **위치:** 계획:1044~1069, 1074~1083, 1511~1528 (`startSession`, `authorize`, Gateway 핸들러).
- **문제:** createSession/listTurns/findSession/findTurnByClientMsgId 및 replay의 DB 예외는 처리되지 않는다. Gateway도 service 호출을 감싸지 않아 핸들러 Promise가 reject되면 설계한 `Ack<{…}>` 오류를 반환하지 못한다.
- **근거:** reserveTurn·엔진·완료 저장에만 일부 catch가 있고, 접근 조회/세션 생성 실패에는 없다. 일반 Nest 소켓 예외 처리가 호출자의 ack를 ErrorCode 기반 실패 union으로 바꿔준다는 근거도 계획에 없다. 사용자는 emitWithAck가 timeout되는 동안 요청 수락 여부를 알 수 없게 된다.
- **제안:** 수락 전 실패를 INTERNAL 실패 ack로 변환하는 경계를 두고 내부 예외는 값/SQL 없이 서버에 기록한다. 수락된 요청은 ack와 최종 오류의 책임을 구분한다. 조회·세션 생성·stale 복구 저장이 각각 실패할 때 ack가 정해진 시간 안에 반환되고 슬롯/진행 목록이 누수되지 않는 테스트를 추가한다. HTTP 미지 예외도 ApiErrorSchema 형태로 매핑하는 정책을 정한다.

### B2. Major · stale replay가 DB 상태 변경 성공을 무시하고 실패를 꾸며 발송

- **위치:** 계획:1114~1129 (`replay`).
- **문제:** failTurn의 boolean을 확인하지 않고 원래 row를 failed(RESTARTED)로 복제해 보낸다. 읽은 row가 오래된 processing이고 실제 턴이 그 사이 completed/failed로 바뀌었다면, DB 결과와 다른 오류를 전달한다.
- **근거:** 2A failTurn은 `status=processing`일 때만 바꾸고 아니면 false를 반환한다. 가능한 순서: processing row 조회 → 처리 완료/진행 목록 해제 → replay의 inflight 검사 false → failTurn false → 이미 완료된 턴에 RESTARTED 이벤트. “저장 결과 확인 후 이벤트” 계약을 위반한다. 본 리뷰에서 DB 경합을 실행한 것은 아니다.
- **제안:** 변경 성공 때만 해당 오류를 발송한다. false면 최신 row를 다시 조회해 실제 completed/failed 결과를 재발송한다. stale 조회와 완료/실패 사이에 제어 가능한 barrier를 넣어, 잘못된 RESTARTED가 나오지 않는 테스트를 둔다.

### B3. Major · 재연결 이력 조회와 room 참여 사이에 완료 이벤트 유실

- **위치:** 계획:1044~1069, 1507~1514, 설계의 재연결 upsert 동기화.
- **문제:** session:start는 이력을 조회한 뒤 room에 참여한다. 이력이 processing을 반환하고 room join 전 완료 이벤트가 발송되면, 클라이언트는 오래된 processing 상태만 받고 최종 결과를 놓칠 수 있다.
- **근거:** 다른 처리 작업과 listTurns/join 사이에는 동기화가 없다. 기존 재연결 테스트는 질문 완료를 300ms 기다린 뒤 연결하므로 이 경합 구간을 만들지 않는다. chat:send에서 권한 확인 후 먼저 join하는 조치는 이 session:start 경로에는 적용되지 않는다.
- **제안:** 기존 세션은 권한 확인→room join→최신 이력 조회 순서로 처리한다. 새 세션도 생성 후 join한 다음 조회하는 경계를 정한다. 이력과 동시에 받은 이벤트는 turnSeq 기반 upsert로 정리한다. 권한 없는 소켓은 join하지 않아야 한다. 조회/join 사이에 완료를 강제로 발생시키는 테스트를 추가한다.

### B4. Major · 큐 대기 상한을 dequeue 시점에만 검사

- **위치:** 계획:1105~1109, 1146~1150, 919~937.
- **문제:** 대기 작업은 queueMs가 지나도 바로 종료되지 않는다. 앞 작업이 끝나 자신이 실행될 때에만 QUEUE_TIMEOUT으로 바뀌므로 “큐 대기 상한 10초”가 실제 종료 상한이 아니다.
- **근거:** enqueuedAt 비교 외에 대기 만료 timer/취소가 없다. 앞 작업들이 엔진·저장을 연속 수행하면 뒤 요청은 10초보다 오래 processing/슬롯 점유 상태로 남는다. 테스트는 앞 작업을 풀어준 다음 timeout을 확인하므로 이 결함을 허용한다.
- **제안:** 예약된 대기 작업에 실제 만료를 두고, 만료된 항목은 영속 failed를 확인한 뒤 슬롯을 정확히 한 번 반환한다. 나중에 chain 차례가 와도 실행/중복 반환하지 않게 상태를 둔다. 앞 작업을 풀지 않은 상태에서 기한 내 오류·슬롯 회수·후속 실행 부재를 검증한다. 영속 큐나 분산 큐는 필요 없다.

### B5. Major · CORS 설정만으로 WebSocket Origin 허용 목록을 보장하지 못함

- **위치:** 계획:1396~1407 (`ConfiguredIoAdapter`), 1445~1476.
- **문제:** IoAdapter는 cors.origin만 설정하고 WebSocket handshake Origin은 검사하지 않는다. 설계의 CORS/Origin 허용 목록을 WebSocket 경로에서 강제하지 못한다.
- **근거:** 공식 문서는 CORS가 HTTP long-polling에 적용되고 WebSocket은 해당 제한을 받지 않는다고 명시하며 allowRequest를 제시한다. [Socket.IO 공식 CORS 문서](https://socket.io/docs/v4/handling-cors/) 인증 middleware가 있으므로 **이 지적은 토큰 인증이 우회된다는 뜻은 아니다**. 유효 토큰을 사용한 비허용 Origin을 별도로 막을 수 없다는 문제다.
- **제안:** Engine.IO allowRequest 또는 이에 준하는 handshake 검사로 Origin 정책을 적용한다. Origin 없는 CLI/네이티브 클라이언트 허용 여부를 명시한다. 허용/비허용 Origin을 polling과 websocket 각각에서 테스트하고 토큰 검증도 계속 유지한다.

### B6. Major · 보관기간 테스트가 구현의 processing 보호 조건과 모순

- **위치:** 계획:2195~2205, 2220~2227.
- **문제:** 테스트는 old 세션에 reserveTurn만 호출해 processing 턴을 만든 뒤 삭제 1건을 기대한다. 구현은 processing 턴이 있는 세션을 삭제에서 제외하므로 기대값을 만족할 수 없다.
- **근거:** reserveTurn의 상태는 2A 계약상 processing이고 deleteOlderThan의 where는 `turns.none(status=processing)`이다. 코드를 그대로 구현하면 old가 보호돼 삭제 수가 0이다. 이는 DB를 실행해 관측한 실패가 아니라 조건과 fixture의 직접적인 모순이다.
- **제안:** 삭제 대상 fixture를 completed/failed로 만든다. 별도 오래된 processing 세션은 삭제되지 않는 테스트로 둔다. trace/review cascade도 실제로 생성한 뒤 확인한다. 처리 중 보호 조건을 지워서 테스트만 통과시키지 않는다.

### B7. Minor · 복구 재발송이 요청 소켓이 아니라 room 전체로 전달됨

- **위치:** 계획:1080~1085, 1116~1123, 1490~1492.
- **문제:** completed/failed duplicate 복구는 동일 room의 모든 소켓으로 다시 broadcast된다. 한 소켓의 재전송 때문에 정상 수신한 다른 소켓도 동일 done/error를 반복해서 받는다. 중복 요청은 send 레이트 리밋을 우회하므로 room fan-out을 반복 유발할 수 있다.
- **근거:** ChatEvents 포트에 단일 수신자 개념이 없고 replay와 새 처리의 이벤트 포트를 공유한다. 기존 단위 테스트 Recorder는 1개이며 여러 소켓에서 수신 횟수를 확인하지 않는다.
- **제안:** 새 완료는 room으로, 복구 replay는 요청 소켓으로 보내는 별도 포트/대상을 정의한다. 복구 요청은 처리 예산과 별개로 가벼운 남용 제한을 적용한다. 두 소켓에서 한쪽만 재전송할 때 다른 쪽의 수신이 늘지 않는 테스트를 둔다.

### B8. Minor · trace 테스트가 같은 room의 비debug 수신을 검증하지 않음

- **위치:** 계획:1363~1384, 1180~1181, 1493~1503.
- **문제:** debug와 비debug 테스트는 서로 다른 사용자의 서로 다른 세션이다. 서비스의 요청자 debug 게이트만으로도 통과하므로 Gateway의 수신자 필터가 제거돼도 이 테스트는 누출을 잡지 못한다. 요청자가 비debug일 때 같은 room의 권한 있는 debug 관찰자도 trace를 받지 못한다.
- **근거:** Gateway 코드는 수신 소켓의 debug를 다시 검사하므로 현재 코드에서 직접 trace 우회를 확인한 것은 아니다. 다만 process는 요청자에게 debug가 없으면 trace 포트를 아예 호출하지 않는다. fetchSockets Promise 실패의 catch도 없다.
- **제안:** 동일 세션에 접근 가능한 debug/비debug principal을 동시에 넣고 두 방향 요청을 시험한다. 권한 없는 다른 세션 소켓은 room 자체에 들어가지 않는지 확인한다. trace 전송 실패는 안전하게 기록하고, trace를 생성/전달할 기준은 수신자 권한으로 정한다. 비debug 소켓에서 수신 부재는 완료 직후 한 번 검사하는 데 그치지 않는다.

### B9. Minor · REST 입력/관리 제한과 공유 DTO가 선언된 계약을 덜 보장

- **위치:** 계획:2070~2079 (`review`), 2090~2145 (`AdminController`), 505~506 (`ApiErrorSchema`).
- **문제:** review Body에는 전체 8KB 검사가 없다. 관리 제한 30건은 검수 쓰기에만 적용되고 reload는 독립 6건 제한이다. API rate-limit 응답의 retryAfterMs는 ApiErrorSchema에 없어 공유 스키마로 파싱하면 사라진다.
- **근거:** Global Constraints는 모든 수신 payload의 먼저 8KB 검사와 관리 API 30건을 명시했다. ReviewRequest의 메모+20개 긴 청크 ID는 필드 검증을 통과하면서 UTF-8 8KB를 넘을 수 있다. 보통 GET은 읽기 제한을 별도로 둘 수 있지만 현재 정책이 그 예외를 명시하지 않는다.
- **제안:** REST body에도 raw/전체 크기 검사를 적용하고, 관리 제한의 적용 범위를 명시해 공유 limiter로 집계한다. ApiErrorSchema에 retryAfterMs를 추가하고 rate-limit 본문 계약을 테스트한다. malformed 세션/검수 cursor는 INVALID_INPUT으로 거절하도록 날짜/ID 구조를 검증한다.

### B10. Minor · 내보낸 평가 항목이 원 대화 문맥·정답 근거를 잃음

- **위치:** 계획:2267~2299 (`export-reviews`).
- **문제:** 모든 항목의 turns를 빈 배열로 만들고, correct extractive에서도 reviewer가 expectedChunkIds를 따로 적지 않았다면 근거 집합이 없다. 원래 문맥으로 맞았던 후속 질문을 단독 질문으로 바꾸거나 정답 판정 불가능한 평가 항목을 만든다.
- **근거:** trace에 contextTurnSeqs와 실제 sources가 있지만 export에서 사용하지 않는다. wrong/partial도 항상 ANSWER/REFERENCE/HOLD를 허용하여 범위밖·주입의 수정 라벨을 표현하지 못한다. 주석상 tune 후보이므로 무조건 자동 정답 데이터라는 주장은 하지 않는다.
- **제안:** 사용한 문맥과 source를 복원하고 지식 버전/팩 범위를 표시한다. 라벨을 충분히 결정할 수 없는 항목은 수동 검수 후보로 분리하며 곧바로 평가 입력에 넣지 않는다. correct FAQ/extractive·followup·blocked 수정 사례로 export를 검사한다.

### B11. Minor · 세션 마지막 활동 기준 삭제가 턴별 보관기간과 다름

- **위치:** 계획:2177, 2220~2227, 설계의 RETENTION_DAYS 지난 턴/trace/review 삭제.
- **문제:** lastActiveAt이 최근이면 해당 세션의 오래된 턴·trace·review도 계속 남는다. 세션을 계속 사용하는 경우 개별 기록의 90일 보관 상한이 되지 않는다.
- **근거:** deleteMany의 대상은 세션이며 턴 createdAt 기준은 없다. 설계는 오래된 턴/trace/review 삭제로 표현돼 있다. 가상 MVP에서의 정책 차이이며 실제 개인정보 보관 위반을 확인한 것은 아니다.
- **제안:** 세션 비활성 기간 기반 보관으로 설계를 명시적으로 바꾸거나 턴별 cutoff를 적용하고 빈 세션을 정리한다. 문맥/trace 참조 보존과 진행 중 턴 제외 정책도 함께 정한다.

## 동시성·권한·테스트 종합 판단

- withLock의 settled chain 정리와 run의 세션별 chain, 기본 슬롯 카운팅에는 이번 검토에서 별도 순서 오류를 확인하지 못했다. reserveTurn 실패 때 release, process finally의 진행 목록/슬롯 반환은 있다. 다만 run이 모든 예외를 삼키므로 위 orchestration/전송 예외의 진단과 종료 책임은 명확히 해야 한다.
- REST trace는 debug + 세션 소유권/admin 접근, 검수/관리는 admin, 세션 목록은 비admin의 userId로 필터링한다. 소켓 send는 authorize 후 join하고 service에서 재확인한다. **확정적인 타 사용자 세션/trace 접근 우회 지적은 없다.** B3의 subscribe 경계, B5 Origin, B8 권한 회귀 테스트는 보완이 필요하다.
- 현재 테스트의 20ms settle/300ms 대기는 순서를 통제하는 증거가 아니다. stale 조회→완료, subscribe→snapshot, queue timeout→앞 작업 미완료, 두 소켓 replay, 동일 room trace, DB 이중 실패와 ack 오류를 barrier/가짜 시계로 재현한다. 테스트 이름의 “ack→status→done”도 실제 발생 순서를 기록해서 비교해야 한다. Gateway가 이벤트를 ack보다 먼저 보낼 수 있다는 주석과 front 처리 계약을 맞춘다.
- 계획의 API 사용이 4.8.3과 맞다는 완전한 확인은 아직 못 했다. 해당 버전 `.d.ts`를 확보한 정적 검사, namespace 인증 E2E, 실제 DB 통합·build 결과가 필요하다. 계획에 있는 버전/인증 실패 시 임의 계약 변경 대신 멈추고 보고하는 지침은 유지한다.

**구현 의견: No-Go.** B1~B6을 정리한 뒤 구현을 시작하고, B7~B11은 구현 작업·계약 테스트에 연결한다. 새 서비스나 분산 인프라를 추가할 필요는 없다.
