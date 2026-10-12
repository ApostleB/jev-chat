/**
 * 대화 로그 intent 필터 선택지. 서버 REST에는 의도 목록을 주는 엔드포인트가 없고(AdminConfig에도 없음),
 * protocol에도 상수가 없어 도메인 팩(jev-chat-api/domain-pack/hanbit-erp/intents.yaml)의 id를 그대로 둔다.
 * 서버는 intent를 임의 문자열(최대 30자)로 받으므로 팩이 바뀌어도 필터 요청 자체는 깨지지 않는다.
 */
export const INTENT_IDS = ["regulation", "how_to", "error", "account_access", "smalltalk", "out_of_scope"] as const;
