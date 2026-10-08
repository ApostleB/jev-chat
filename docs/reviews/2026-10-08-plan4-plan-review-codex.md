# 계획 4 구현 전 검토

- 대상: `docs/superpowers/plans/2026-10-08-plan4-front.md`, 설계 v3 프로토콜·개정 계획 2B, 2026-10-08. 이하 `계획:행`은 대상 파일이다.
- AGENTS.md에 따라 결과만 작성했다. 기존 파일 수정·프로젝트 설치·실제 env 열람·실제 서버/브라우저 실행은 하지 않았다. 계획의 순수 리듀서/ChatClient/FakeSocket은 `/tmp/jev-plan4-review`에서 합성 입력으로 재현했다.
- **구현 의견: No-Go.** 소켓 검증·불확실한 ack 재전송·세션 격리·로그아웃 캐시 및 지원하지 않는 Query API를 먼저 수정해야 한다.

## API 확인 범위

- Node 22로 scratch의 `npm pack ... --ignore-scripts`를 시도했으나 `ENOTFOUND registry.npmjs.org`로 실패했다. 정확한 shadcn 4.21.4/Tailwind 4.3.3/@tailwindcss/vite와 TanStack 5.104.1 선언은 확보하지 못했다.
- 기존 설치의 `@types/react@19.3.0`, `vite@8.3.3`에서 **타입 선언/package.json만 scratch에 복사**하여 확인했다(`/tmp/jev-plan4-review/types`). useReducer/useRef(null)/useEffect와 Vite defineConfig/plugin 옵션 형태는 존재한다. UI 패키지 JS나 shadcn CLI는 실행하지 않았다.
- Vite 플러그인 + `@import "tailwindcss"` 방향은 [Tailwind 공식 Vite 설치 문서](https://tailwindcss.com/docs/installation/using-vite)와 맞다. shadcn init/add 명령은 [공식 CLI 문서](https://ui.shadcn.com/docs/cli)에 있지만 **최신 문서를 4.21.4의 정확한 선언 검증으로 간주하지 않는다**. Vite용 template/base/생성 경로를 명시하고 실제 생성물 타입을 확인해야 한다.
- Socket.IO 4.8.3 선언의 이전 확보 한계도 유지된다. 주입 가능한 SocketLike/`as never`는 실제 소켓 API 타입 검증을 대신하지 않는다. 전체 생성 UI의 build/typecheck는 아직 실행하지 않았다.

## 지적

### U1. Major · 소켓 이벤트와 ack를 zod로 검증하지 않음

- **위치:** 계획:831~865 (`ChatClient`).
- **문제:** 서버 이벤트는 e:never로 dispatch하고 ack는 타입 단언만 한다. 모든 서버 데이터를 공유 zod 스키마로 검증한다는 계약과 다르다. malformed session 응답은 startSession의 hydrate에서 미처리 예외로 이어질 수도 있다.
- **근거:** 합성 서버 ack `{ok:true,data:{turnId:42,turnSeq:-1,status:"not-a-status"}}`를 실제 계획 코드가 정상 ack 액션으로 전달했다. 테스트의 status 이벤트도 UUID가 아닌 clientMsgId="c"를 사용하여 검증 부재를 허용한다.
- **제안:** SessionStartAckSchema/ChatSendAckSchema 및 각 이벤트 스키마로 unknown을 검증한 후 dispatch한다. 검증 실패는 명확한 연결/응답 오류로 처리하고 state를 변경하지 않는다. 숫자 ID·음수 seq·잘못된 status·누락 data/turns·null 이벤트를 시험한다. raw 타입 단언으로 통과시키지 않는다.

### U2. Major · 완료 후 ack timeout을 실패로 남기고 새 ID로 중복 처리

- **위치:** 계획:573~587, 847~862, 893~894, 1177~1201.
- **문제:** done이 먼저 도착해도 뒤따르는 ackFailed는 sendError를 추가하고 done/hydrate는 이를 지우지 않는다. 성공한 턴에 재시도 오류가 남는다. ack 유실은 수락 여부 미확정인데 retry는 항상 새 clientMsgId여서 동일 질문이 새 턴으로 실행될 수 있다.
- **근거:** 리듀서 합성 재현에서 completed 답변과 retryable INTERNAL sendError가 동시에 남았다. ChatThread는 이를 오류/다시 보내기로 표시한다. ChatClient의 ack timeout 후 같은 질문 send 두 번은 서로 다른 UUID를 전송했다. “새 ID로 다시 보내기”는 **이미 확정된 실패 턴** 정책과 구분해야 한다.
- **제안:** 서버 terminal 결과가 로컬 ack 오류보다 우선하고 terminal 결과 수신 시 sendError를 해제한다. 미확정 ack는 동일 ID·동일 text 복구 재전송 또는 이력 확인으로 수락/완료를 확인한다. 확정 실패를 다시 처리할 때만 새 ID+retryOfTurnSeq를 사용한다. done→ack timeout, timeout→done/hydrate, 처리 중 재연결 복구가 중복 Judge 호출을 만들지 않는 테스트를 추가한다.

### U3. Major · 이전 세션/연결의 늦은 ack·hydrate가 새 상태에 섞임

- **위치:** 계획:535~575, 838~844, 864~869, 885~899.
- **문제:** ack/ackFailed/localSend 액션에 sessionId/연결 세대가 없고, startSession 응답도 요청 세대를 확인하지 않는다. 새 세션 생성·토큰 교체·close 이후의 이전 Promise 완료가 현재 state를 바꿀 수 있다.
- **근거:** 세션 B로 hydrate한 뒤 세션 A의 ack를 넣자 B에 old-A-turn이 processing으로 추가되는 것을 재현했다. session:start 응답이 역순으로 오면 currentSession과 전체 hydrate가 뒤집힐 수도 있다. close는 disconnect만 하고 진행 중 ack/이벤트의 후속 dispatch를 무효화하지 않는다.
- **제안:** 클라이언트/세션 generation과 sessionId를 비동기 요청·액션에 붙여 오래된 결과를 무시한다. close에서 listener 해제와 pending 요청 무효화를 수행한다. 세션 전환·토큰 교체·StrictMode cleanup 중 늦은 ack/hydrate를 barrier로 검사한다. 채팅 session과 상태를 같은 수명 범위에서 관리한다.

### U4. Major · 연결됨과 세션 준비를 혼동하고 거부 후 재연결 동작 없음

- **위치:** 계획:821~830, 838~844, 879~908, 1280~1296.
- **문제:** connect 즉시 connected로 표시하고 session:start 실패는 `{ok:false}`로 조용히 버린다. Composer는 connected면 활성화되어 세션 미확정/실패 상태에서 send를 시도한다. rejected를 표시하지만 useChat/ChatPage에 명시적 reconnect API/버튼이 없다.
- **근거:** middleware 거절은 자동 재연결을 하지 않는다고 계획도 명시한다. 새 세션 버튼은 startSession만 호출하고 socket.connect를 호출하지 않는다. 최초 이력 조회 INTERNAL이나 타임아웃의 이유를 사용자에게 전달하거나 retry할 경로도 없다.
- **제안:** socket connected와 conversation ready/syncing/error를 분리한다. 세션 ack 완료 뒤 송신을 허용하고 실패 code를 표시한다. 수동 reconnect를 훅/UI에 제공하고, 일반 네트워크 재시도와 인증·버전 거절을 구분한다. session:start 실패/지연·connect_error·서버 disconnect 후 실제 재접속 테스트를 둔다.

### U5. Major · TanStack Query v5에 없는 useQuery 3인자 호출

- **위치:** 계획:1518 (`SettingsPage`), dependencies 79행.
- **문제:** `useQuery(["config"], fn, {enabled})`는 v5에서 지원하지 않는다. 계획의 v5.104 의존성과 맞지 않아 typecheck/런타임에 실패할 수 있다.
- **근거:** 공식 v5 migration 문서는 단일 options object만 지원한다고 명시한다. [TanStack 공식 v5 문서](https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5)
- **제안:** `useQuery({queryKey,queryFn,enabled})`로 바꾸고 useMutation 등도 v5 object 형식으로 작성한다. token 유무와 무관하게 훅 호출 순서는 고정하고 enabled로 제어한다. 실제 패키지 선언과 SettingsPage typecheck를 확인한다.

### U6. Major · 로그아웃/토큰 교체 시 민감한 Query 캐시를 비우지 않음

- **위치:** 계획:242~250, 1481~1500, 1518~1519.
- **문제:** token만 sessionStorage에서 지우고 전역 QueryClient 데이터·진행 중 REST 요청을 유지한다. query key도 인증 세대와 연결된 계약이 없다. 다른 토큰으로 로그인하면 이전 관리자 세션/trace/config가 같은 캐시에서 다시 표시될 위험이 있다.
- **근거:** QueryClient는 root에 유지되며 logout에는 clear/cancel 처리가 없다. 고정 config key가 예시에 명시됐다. 이전 권한 데이터가 캐시에 남는 문제이며, 서버 REST 소유권 자체의 우회를 확인한 것은 아니다. UI가 미구현이므로 노출은 위험 분석이다.
- **제안:** logout/토큰 변경 때 소켓·채팅·선택 trace·진행 요청을 정리하고 인증별 query cache를 clear하거나 새 QueryClient로 교체한다. key에는 raw 토큰 대신 인증 세대를 사용한다. 늦은 이전 요청이 캐시를 다시 채우지 못하도록 취소/세대 검사를 둔다. admin→logout→user에서 이전 데이터가 노출되지 않는 테스트를 추가한다.

### U7. Major · FakeSocket 중복 connect가 재연결 테스트와 모순

- **위치:** 계획:332~337, 670~690.
- **문제:** FakeSocket.connect는 이미 connected여도 connect 이벤트를 다시 발송한다. ChatClient.connect가 이를 한 번 호출하고 테스트가 다시 sock.connect를 호출하여 최초 session:start가 두 번 발생한다.
- **근거:** 계획의 두 코드를 합성 실행하자 최초 connect에서 session:start 2건을 확인했다. 따라서 재연결 테스트의 기대 `[{}, {sessionId}]`와 달리 초기 `{}`가 2개가 될 수 있다. 이 테스트는 실서비스 재연결 계약의 증거가 되지 않는다.
- **제안:** fake의 connect 시점/중복 연결 동작을 실제 소켓과 맞추거나 테스트가 serverEmit("connect")를 명시적으로 제어하게 한다. timeout/ack 유실·지연도 fake가 재현할 수 있어야 한다. 테스트를 production 결함에 맞춰 약화하지 않는다.

### U8. Minor · terminal hydrate가 상태뿐 아니라 필요한 질문 메타데이터도 버림

- **위치:** 계획:563~568.
- **문제:** prev가 terminal이고 hydrate가 processing이면 prev 전체를 유지한다. 이벤트로만 만들어 userText가 빈 턴에 늦게 받은 실제 질문도 보충하지 못한다.
- **근거:** done으로 생성한 턴에 userText="실제 질문"인 processing hydrate를 넣었을 때 userText가 빈 문자열로 남는 것을 재현했다. status의 역행을 막는 의도는 맞지만 불변 메타데이터 병합은 필요하다.
- **제안:** terminal 상태/답변은 유지하면서 turnId·clientMsgId·질문 등 검증된 메타데이터를 병합한다. peer 소켓 이벤트와 늦은 snapshot을 포함해 검사한다. done/error의 상충 terminal 결과에 대한 우선순위도 정의한다.

### U9. Minor · 최초/재연결 이력 cursor가 훅에 전달되지 않음

- **위치:** 계획:821~824, 880~905, 1279~1284.
- **문제:** 자동 startSession이 돌려준 hasMore/nextBeforeTurnSeq를 버려 older는 null로 남는다. 정상 경로에서 이전 대화 버튼이 활성화되지 않는다. 화면 전환으로 ChatPage가 unmount되면 ChatClient/session도 잃어 돌아올 때 새 세션을 만든다.
- **근거:** older를 설정하는 곳은 newSession/loadOlder뿐이며 새 세션은 보통 빈 이력이다. App은 화면별 조건부 렌더링으로 채팅 훅을 제거한다.
- **제안:** 동기화 메타데이터를 훅 상태/액션으로 전달한다. 현재 세션을 화면 전환보다 긴 수명에 두거나 자동 새 세션을 명시적 UX 결정으로 정한다. 50개 초과 이력 재연결·이전 페이지·다른 화면 왕복 테스트를 둔다.

### U10. Minor · 입력/검수 submit의 중복·실패·늦은 완료 처리 부족

- **위치:** 계획:1217~1233, 1434~1460, 1292.
- **문제:** Composer는 ack 대기 중 같은 입력을 다시 submit할 수 있고, 뒤늦은 setText("")가 그동안 편집한 새 초안을 지운다. ReviewForm은 onSubmit rejection을 처리하지 않아 403/저장 실패가 미처리 Promise가 될 수 있다.
- **근거:** submit busy 상태와 요청별 입력 snapshot/완료 세대 확인이 없고 review form은 `void submit()`만 사용한다. 컴포넌트는 아직 실행하지 않았으므로 코드 분석이다.
- **제안:** 전송 중 UI 정책을 정하고 완료 시 해당 초안만 정리한다. 검수 실패를 안전한 메시지로 보여주고 중복 저장을 막는다. 지연 ack 중 타이핑/Enter 반복과 review 403/500을 테스트한다.

## 보안·테스트 판단

- 서버 텍스트를 JSX 문자열·pre/CSS pre-wrap으로 렌더링하고 HTML/Markdown을 해석하지 않는 방향은 맞다. HTML 태그가 실제 요소로 생성되지 않는 테스트도 있다. token은 sessionStorage에만 저장하고 VITE_API_URL만 공개 설정으로 사용하는 방향도 맞다. 직접적인 XSS 코드 경로는 발견하지 못했다. 로그아웃 데이터 수명은 U6이다.
- 현재 reducer의 done-before-ack 및 completed→processing 차단 테스트만으로 U2/U3/U8을 잡지 못한다. ack timeout→done, done→timeout, 세션 전환 후 늦은 응답, malformed packet, 같은 ID 복구 재전송, hook cleanup, reconnect 초기 실패를 추가한다.
- UI 패키지 전체의 정확한 선언 확보·shadcn 생성물 build/typecheck·실제 Socket.IO smoke가 아직 필요하다. 검증 불가한 버전을 최신 공식 문서로 확정 판정하지 않았다.

## 결론

**구현 No-Go.** U1~U7을 계획에서 정리한 뒤 진행한다. U8~U10도 실제 프로토콜/훅/컴포넌트 회귀 테스트에 연결한다. React/shadcn 화면을 늘리기 전에 순수 상태·연결 계층의 계약을 먼저 확정하는 것이 필요하다.
