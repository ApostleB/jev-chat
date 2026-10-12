import { ChatDoneEventSchema, ChatErrorEventSchema, TurnSchema } from "@jev-chat/protocol";
import { describe, expect, it } from "vitest";
import type { TurnRow } from "../../adapters/persistence/turn.repository";
import { toDoneEvent, toErrorEvent, toProtocolTurn } from "./turn-mapper";

const sid = "00000000-0000-4000-8000-000000000001";
const base: TurnRow = {
  id: "t1", sessionId: sid, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a1", userText: "q",
  status: "processing", errorCode: null, errorRetryable: null, assistantText: null, route: null, sources: null, traceId: null, createdAt: new Date(),
};
const src = [{ chunkId: "c1", versionId: "v1", contentHash: "h", title: "법인카드 규정", section: "한도" }];

describe("turn-mapper (프로토콜 스키마를 실제로 통과해야 한다)", () => {
  it("processing 턴", () => {
    expect(TurnSchema.parse(toProtocolTurn(base))).toMatchObject({ status: "processing" });
  });
  it("정상 completed 턴과 done 이벤트", () => {
    const row: TurnRow = { ...base, status: "completed", assistantText: "답", route: "faq", sources: src, traceId: "tr1" };
    expect(TurnSchema.parse(toProtocolTurn(row))).toMatchObject({ route: "faq", traceId: "tr1" });
    const done = ChatDoneEventSchema.parse(toDoneEvent(row, sid));
    expect(done).toMatchObject({ turnId: "t1", turnSeq: 1, route: "faq", traceId: "tr1" });
    expect(done.error).toBeUndefined();
  });
  it("route=error로 completed된 턴은 error를 포함", () => {
    const row: TurnRow = { ...base, status: "completed", assistantText: "일시적 문제", route: "error", sources: [], traceId: "tr2", errorCode: "JEV_UNAVAILABLE", errorRetryable: true };
    expect(TurnSchema.parse(toProtocolTurn(row)).error).toEqual({ code: "JEV_UNAVAILABLE", retryable: true });
    expect(ChatDoneEventSchema.parse(toDoneEvent(row, sid)).error).toEqual({ code: "JEV_UNAVAILABLE", retryable: true });
  });
  it("failed 턴과 error 이벤트", () => {
    const row: TurnRow = { ...base, status: "failed", errorCode: "RESTARTED", errorRetryable: true };
    expect(TurnSchema.parse(toProtocolTurn(row)).error).toEqual({ code: "RESTARTED", retryable: true });
    expect(ChatErrorEventSchema.parse(toErrorEvent(row, sid, "다시 시도해주세요."))).toMatchObject({ code: "RESTARTED", retryable: true });
  });
  it("알 수 없는 errorCode는 INTERNAL로 정규화", () => {
    const row: TurnRow = { ...base, status: "failed", errorCode: "WEIRD", errorRetryable: false };
    expect(toProtocolTurn(row).error).toEqual({ code: "INTERNAL", retryable: false });
  });
});
