# 계획 3 구현 전 검토

- 대상: `docs/superpowers/plans/2026-10-08-plan3-data-eval.md`, 설계 v3 6장, 2026-10-08. 이하 `계획:행`은 대상 파일이다.
- AGENTS.md에 따라 검토 결과만 작성했다. **실제 tune/chunks/holdout 파일은 열람하지 않았고 Task 6 데이터 작성도 하지 않았다.** 계획의 코드·작성 절차만 확인했다.
- `/tmp/jev-plan3-review`에 채점/지표 예시 코드만 추출하여 합성 항목으로 실행했다. 실제 Jev/DB/평가셋 호출, 기존 파일 수정은 없다.
- **구현 의견: No-Go.** 현재 하네스는 실패를 합격으로 표시하고 holdout 반복 제한을 우회할 수 있다.

## 지적

### E1. Major · allowed 위반과 빈 평가가 전체 합격을 막지 않음

- **위치:** 계획:710~723, 1040, 1066.
- **문제:** allowedViolationRate에 합격 기준이 없고 overallPass도 allowed=false를 검사하지 않는다. 빈 scores의 모든 rate/pass는 null이라 overallPass=true다. holdout도 --limit 0을 허용한다.
- **근거:** 합성 실행에서 `computeMetrics([]).overallPass=true`, 정상 점수의 allowed만 false로 바꿔도 overallPass=true를 확인했다. 설계는 허용 outcome 밖이면 실패라고 정했다. CLI는 지표 불합격에도 exitCode를 바꾸지 않아 정상 종료할 수 있다.
- **제안:** allowed 위반을 전체 실패에 반영하고 빈/필수 coverage 부족 평가를 거절한다. holdout에는 limit 금지, tune limit은 양의 정수로 검증한다. 불합격 exitCode도 명시한다. 0항목·허용 밖의 정답 FAQ·allowed=false 한 건을 종합 판정 테스트로 둔다.

### E2. Major · 정답 제공/보류 분모와 Recall@5/@8 집계가 설계와 다름

- **위치:** 계획:685~708, 1050.
- **문제:** 정답/보류 eligible은 type만 보고 정하므로 ANSWER가 허용되지 않은 ambiguous도 포함하고 정상 질문이 섞인 injection은 모두 제외한다. gold의 in-scope 및 allowed_outcomes 조건을 사용하지 않는다. followup recall은 별도 출력하지만 threshold가 없고 일반 recall에서는 제외한다. Recall@5/@8은 후보 전체를 검사한다.
- **근거:** 합성 정상 ANSWER 1건 + HOLD만 허용한 ambiguous 1건에서 정답 제공 분모가 2였다. 설계대로라면 ANSWER 허용 in-scope 1건이다. 정책 후보 수를 10/12로 바꾸면 7위 FAQ·10위 청크까지 각각 Recall@5/@8 성공으로 셀 수 있다.
- **제안:** ItemScore에 gold 기반 eligibility를 보존하고 CLI도 이를 사용한다. recall은 실제 앞 5/8 후보를 검사한다. 전체 recall 합격선과 followup 별도 집계/합격 정책을 명확히 연결한다. 혼합 injection, HOLD-only, 정답이 제한 순위 밖인 사례를 검사한다.

### E3. Major · option_order 두 번째 실행의 오답/오류를 버림

- **위치:** 계획:983~989.
- **문제:** 역방향 점수 s2는 결과 식별 비교에만 사용하고 r1의 채점 flags를 그대로 반환한다. s2의 오답·공격 성공·내부/외부 오류는 최종 점수에 보존되지 않는다. 불일치는 allowed=false만 만들며 E1 때문에 합격할 수도 있다.
- **근거:** 첫 실행은 정답 FAQ, 둘째는 내부 ERROR이면 first.correctAnswer=true/failure=none이 남는다. 같은 outcome/FAQ/근거여도 서로 다른 intent나 실패/라벨 결과는 비교하지 않는다.
- **제안:** 정·역 결과/점수 둘 다 저장하고 항목의 최종 실패는 어느 쪽 실패든 반영한다. 순서 불일치 자체도 전체 합격을 막는다. 둘째만 오답/공격/내부 오류/공급자 오류인 테스트를 추가한다. FAQ 크기 축소 이전 후보를 뒤집어 실제 전송 후보 집합까지 바뀌지 않는지도 확인한다.

### E4. Major · G1의 오류 원인을 무관한 호출의 provider 실패로 판정

- **위치:** 계획:579, 634~644, 449.
- **문제:** ERROR에서 어떤 호출 하나라도 provider kind이면 항목 전체를 provider로 분류한다. A의 내부 기한/설정 오류가 답변 실패 원인인데 B에서 503이 있었다는 이유로 holdout 재실행 대상이 될 수 있다. timeout도 외부 확인 없이 provider 집합에 들어간다.
- **근거:** 합성 A timeout + B 503의 route=error를 provider로 분류하는 것을 재현했다. 설계 G1은 엔진 기한 초과 등 내부 실패는 실패로 집계하고 확인된 429/529/5xx/연결 장애만 재실행한다.
- **제안:** 실제 경로 결정 실패를 만든 A 또는 B 결과의 원인으로 분류하고, 내부 원인이 함께 있으면 내부 실패를 보존한다. transport timeout과 엔진 기한을 구분하고 HTTP status 증거도 확인한다. A 401+B503, A timeout+B429, B 내부/외부 혼합 실패를 테스트한다.

### E5. Major · 공급자 재실행의 subset만 새로 채점해 원 실패를 잃음

- **위치:** 계획:1038~1064.
- **문제:** providerFailedIds만 실행한 다음 computeMetrics(scores)를 그 subset에 적용하고 RC overallPass로 기록한다. 원 실행의 정상/오답/내부 실패를 합쳐 최종 전체 평가를 만들지 않는다.
- **근거:** 최초 실행에 내부 실패가 있고 외부 실패 1건도 있었다면, 외부 1건만 성공한 재실행은 원 내부 실패와 무관하게 합격으로 표시될 수 있다. 원 실행을 별도 줄로 보관하는 것만으로 종합 판정이 보존되지는 않는다.
- **제안:** 원 항목별 결과를 보존해 허용된 외부 실패 ID만 교체하고 전체 집합으로 지표/합격선을 다시 계산한다. 최초 내부 실패·오답은 남아야 한다. subset 결과와 누적 최종 결과를 구분하고 G1 최대 1회도 유지한다.

### E6. Major · holdout 잠금이 실행 전 예약/동시성/입력 고정을 보장하지 않음

- **위치:** 계획:909~925, 1028~1040, 1060~1064.
- **문제:** 기록을 읽어 허용한 뒤 실행 종료에만 append한다. 같은 RC의 동시 프로세스 또는 리포트 저장/실행 중 종료는 반복 실행을 허용한다. rerun은 pack hash와 lang만 검사하고 holdout 자체 hash·order·코드/템플릿 버전은 고정하지 않는다.
- **근거:** 두 프로세스가 빈 기록을 읽으면 둘 다 first 허용이다. --order 변경도 거절되지 않는다. holdout 파일을 수정하거나 일부만 실행해도 기록의 contentHash는 팩만 나타내고 평가셋 변경은 검출하지 못한다. 잠금 테스트는 함수의 순차 결정만 확인한다.
- **제안:** RC 실행을 원자적으로 예약하고 시작/중단 상태도 남긴다. RC를 코드/템플릿·모델·팩/정책·holdout hash·order 및 실행 범위와 연결한다. 동시 실행·중단 후 재실행·order/평가셋 변경을 거절하는 테스트를 둔다. RC 이름만 바꿔 같은 릴리스 후보를 반복 평가하지 않는 승인 절차도 명시한다.

### E7. Minor · 라벨/후속 문맥 형식의 유효성이 약함

- **위치:** 계획:278~297, 360~392, 628~631.
- **문제:** turns의 완결된 user/assistant 교대와 gold 집합 조건을 검증하지 않는다. malformed/홀수 문맥은 ItemContextReader가 조용히 건너뛰거나 빈 assistant로 바꾼다. REFERENCE에 acceptable_chunk_ids가 없거나 shown이 비어도 wrongReference=false다.
- **근거:** loader는 참조 ID 존재만 확인한다. required가 acceptable의 부분집합인지, 허용 ANSWER/REFERENCE에 충분한 gold가 있는지도 없다. 작성자가 잘못된 평가 항목을 넣으면 모델 품질 대신 데이터 결함을 측정할 수 있다.
- **제안:** 완료 턴 교대·짝·sources 역할, gold 집합의 비어 있지 않음/포함 관계와 outcome별 필수 라벨을 검증한다. 후속 문맥은 운영 ContextBuilder와 동일하게 복원/절단하고 문서 참조 정보도 확인한다. REFERENCE의 무근거 출력은 실패로 처리한다. 모든 실제 데이터 검수는 작성 단계의 별도 작업으로 남긴다.

### E8. Minor · 한국어 옵션과 policy override의 검증/추적이 덜 구체적

- **위치:** 계획:135~142, 344~354, 1041~1054.
- **문제:** core 빌더의 영어 기본값·선택지 ID·문맥 유지 방향은 맞지만 policy YAML을 Partial<Policy>로 cast하고 nested 설정을 얕게 덮는다. 언어/순서 비교에서 실제 전송 후보 집합이 달라지면 결과 차이를 언어/옵션 순서 효과로만 해석하기 어렵다.
- **근거:** 잘못된 부분 deadlines/context 객체가 들어가도 runtime validation이 없다. v1 base manifest와 v1-en/v1-ko trace 라벨 구분은 명시됐지만 템플릿 내용 hash/실제 패킹 후보의 비교 기록은 없다. intent criteria는 원 언어를 유지하는 제한을 계획은 명시했으나 리포트 본문에는 그 설명이 없다.
- **제안:** override를 검증하고 nested 병합을 정한다. en/ko 모두 A/B 문맥·none·크기 축소 계약을 검사한다. 동일 입력/정책/후보를 사용했는지 기록하고 리포트에 비교가 지시문/Noul 기준 언어에 한정됨을 표시한다. 런타임 snapshot 라벨과 실제 Judge 언어의 일치도 테스트한다.

### E9. Minor · 독립 holdout 절차는 있으나 coverage/잠금 증거는 보완 필요

- **위치:** 계획:18~21, 1099~1112, 1167~1175, 1195~1201.
- **문제:** 작성자를 분리하고 tune 비열람을 명시한 방향은 맞다. 그러나 Task 6의 유형별 coverage를 자동 검증하는 정의가 없고, 정확한 ID/trim 메시지 중복만 검사한다. 실패 리포트는 holdout의 항목 ID·선택 FAQ/근거를 공개하므로 튜닝 담당의 후속 변경 절차도 필요하다.
- **근거:** 현재 hanbit-pack 테스트의 MIN_TYPES는 tune용이다. 항목 수/중복 검사만으로 파라프레이즈·시나리오 독립성이나 문서 예외 이해를 보장할 수 없다. 숫자를 다른 조항 인용으로만 전달하는 데이터는 청크별 직접 답변 판정의 자족성과 충돌할 수도 있다. 실제 데이터는 열람하지 않았다.
- **제안:** Codex 작업에는 승인된 팩·규칙만 제공하고 tune/튜닝 오답 리포트는 제공하지 않는다. holdout 작성·검수·freeze hash와 coverage를 별도 확인한다. 세부 holdout 결과를 보고 같은 RC를 튜닝하지 않고 변경 시 새 RC로 전체 절차를 재수행한다. 참조 조항의 수치/예외는 청크 단독으로 답할 수 있게 작성됐는지 사람 검수를 포함한다. 자동 overlap 검사는 데이터 본문을 터미널에 노출하지 않는다.

## 결론

**구현 No-Go.** E1~E6은 평가의 합격·재실행·holdout 잠금을 직접 바꾸므로 먼저 계획을 수정해야 한다. 합격선 숫자 자체는 설계와 맞지만 적용 조건이 맞지 않는다. E7~E9와 Task 6 독립 작성은 구현/데이터 검수의 완료 조건으로 연결한다. 이번 검토에서 실제 데이터 작성·열람은 수행하지 않았다.
