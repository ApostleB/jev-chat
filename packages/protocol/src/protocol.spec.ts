import { describe, expect, it } from "vitest";
import {
  AckSchema,
  ChatDoneEventSchema,
  ChatSendRequestSchema,
  ChatSendResponseSchema,
  MessageTextSchema,
  RouteSchema,
  SessionStartResponseSchema,
  isWithinPayloadLimit,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from "./index";

const uuid = "3f1c2a4e-8b7d-4c1e-9a2b-1c2d3e4f5a6b";

describe("MessageTextSchema", () => {
  it("앞뒤 공백을 제거한다", () => {
    expect(MessageTextSchema.parse("  안녕  ")).toBe("안녕");
  });
  it("공백만 있으면 거부한다", () => {
    expect(MessageTextSchema.safeParse("   ").success).toBe(false);
  });
  it("코드포인트 1000자는 허용하고 1001자는 거부한다", () => {
    expect(MessageTextSchema.safeParse("가".repeat(1000)).success).toBe(true);
    expect(MessageTextSchema.safeParse("가".repeat(1001)).success).toBe(false);
  });
  it("이모지(서로게이트 쌍)는 1자로 센다", () => {
    expect(MessageTextSchema.safeParse("😀".repeat(1000)).success).toBe(true);
  });
});

describe("ChatSendRequestSchema", () => {
  it("유효한 요청을 통과시킨다", () => {
    const r = ChatSendRequestSchema.parse({ sessionId: uuid, clientMsgId: uuid, text: "연차 이월 돼요?" });
    expect(r.retryOfTurnSeq).toBeUndefined();
  });
  it("uuid가 아니면 거부한다", () => {
    expect(ChatSendRequestSchema.safeParse({ sessionId: "x", clientMsgId: uuid, text: "a" }).success).toBe(false);
  });
  it("retryOfTurnSeq는 1 이상의 정수", () => {
    expect(ChatSendRequestSchema.safeParse({ sessionId: uuid, clientMsgId: uuid, text: "a", retryOfTurnSeq: 0 }).success).toBe(false);
    expect(ChatSendRequestSchema.safeParse({ sessionId: uuid, clientMsgId: uuid, text: "a", retryOfTurnSeq: 3 }).success).toBe(true);
  });
});

describe("AckSchema", () => {
  const ack = AckSchema(ChatSendResponseSchema);
  it("성공 ack", () => {
    expect(ack.parse({ ok: true, data: { turnId: "t1", turnSeq: 1, status: "accepted" } }).ok).toBe(true);
  });
  it("실패 ack는 error.code가 정의된 값이어야 한다", () => {
    expect(ack.safeParse({ ok: false, error: { code: "QUEUE_FULL", message: "x", retryable: true, retryAfterMs: 1000 } }).success).toBe(true);
    expect(ack.safeParse({ ok: false, error: { code: "NOPE", message: "x", retryable: true } }).success).toBe(false);
  });
});

describe("RouteSchema", () => {
  it("MVP route 7개만 허용한다", () => {
    for (const r of ["faq", "extractive", "reference", "clarify", "blocked", "fallback", "error"]) {
      expect(RouteSchema.safeParse(r).success).toBe(true);
    }
    expect(RouteSchema.safeParse("llm").success).toBe(false);
  });
});

describe("ChatDoneEventSchema / SessionStartResponseSchema", () => {
  it("done 이벤트", () => {
    const e = ChatDoneEventSchema.parse({
      sessionId: uuid, clientMsgId: uuid, turnSeq: 2, turnId: "t2", text: "답",
      route: "extractive", traceId: "tr1",
      sources: [{ chunkId: "c1", versionId: "v1", contentHash: "h", title: "전자결재 규정", section: "제4조" }],
    });
    expect(e.sources).toHaveLength(1);
  });
  it("session:start 응답의 turns", () => {
    const r = SessionStartResponseSchema.parse({
      sessionId: uuid, hasMore: false,
      turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: uuid, userText: "q", status: "failed", error: { code: "RESTARTED", retryable: true } }],
    });
    expect(r.turns[0]?.status).toBe("failed");
  });
});

describe("상수와 크기 검사", () => {
  it("프로토콜 버전은 1", () => expect(PROTOCOL_VERSION).toBe(1));
  it("8KB 초과 페이로드를 거부한다", () => {
    expect(isWithinPayloadLimit({ text: "a".repeat(100) })).toBe(true);
    expect(isWithinPayloadLimit({ text: "a".repeat(MAX_PAYLOAD_BYTES) })).toBe(false);
  });
  it("한국어는 UTF-8 바이트로 센다(한 글자 3바이트)", () => {
    expect(isWithinPayloadLimit({ t: "가".repeat(2700) })).toBe(true);   // 8100바이트 + JSON 오버헤드 < 8192
    expect(isWithinPayloadLimit({ t: "가".repeat(2731) })).toBe(false);  // 8193바이트 이상
  });
});
