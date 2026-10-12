import { describe, expect, it } from "vitest";
import { initialTurns, orderedTurns, turnsReducer, type TurnsAction } from "./turns";

const sid = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-0000000000ff";
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run = (actions: TurnsAction[]) => actions.reduce(turnsReducer, initialTurns);
const done = (n: number, text = "a", sessionId = sid): TurnsAction => ({
  type: "done",
  e: { sessionId, clientMsgId: cid(n), turnSeq: n, turnId: `t${n}`, text, route: "faq", sources: [], traceId: `tr${n}` },
});
const uncertain = { code: "INTERNAL" as const, message: "확인 필요", retryable: true, uncertain: true };

describe("turnsReducer", () => {
  it("로컬 전송 → ack → status → done", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "법인카드 한도" },
      { type: "ack", sessionId: sid, clientMsgId: cid(1), turnId: "t1", turnSeq: 1 },
      { type: "status", e: { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, stage: "judging" } },
      done(1, "50만 원"),
    ]);
    expect(orderedTurns(s)).toEqual([expect.objectContaining({ turnSeq: 1, status: "completed", assistantText: "50만 원", route: "faq", traceId: "tr1", userText: "법인카드 한도" })]);
  });

  it("이벤트가 ack보다 먼저 와도 같은 턴으로 합친다", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
      done(1),
      { type: "ack", sessionId: sid, clientMsgId: cid(1), turnId: "t1", turnSeq: 1 },
    ]);
    expect(orderedTurns(s)).toHaveLength(1);
    expect(orderedTurns(s)[0]).toMatchObject({ status: "completed", assistantText: "a" });
  });

  it("[U2] done 뒤에 온 ack 실패(timeout)는 무시 — 성공한 턴에 오류가 남지 않는다", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
      done(1),
      { type: "ackFailed", sessionId: sid, clientMsgId: cid(1), error: uncertain },
    ]);
    expect(orderedTurns(s)[0]?.sendError).toBeUndefined();
  });

  it("[U2] 미확정 실패 뒤 done/hydrate/status가 오면 sendError를 지운다", () => {
    const base: TurnsAction[] = [
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
      { type: "ackFailed", sessionId: sid, clientMsgId: cid(1), error: uncertain },
    ];
    expect(orderedTurns(run([...base, done(1)]))[0]).toMatchObject({ status: "completed", sendError: undefined });
    expect(orderedTurns(run([...base, { type: "hydrate", sessionId: sid, turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "q", status: "failed", error: { code: "RESTARTED", retryable: true } }] }]))[0]).toMatchObject({ status: "failed", sendError: undefined });
    expect(orderedTurns(run([...base, { type: "status", e: { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, stage: "judging" } }]))[0]?.sendError).toBeUndefined();
  });

  it("[U2] 같은 clientMsgId로 다시 보내면(localSend) 미확정 오류를 지우고 queued로", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
      { type: "ackFailed", sessionId: sid, clientMsgId: cid(1), error: uncertain },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
    ]);
    expect(orderedTurns(s)).toHaveLength(1);
    expect(orderedTurns(s)[0]).toMatchObject({ stage: "queued", sendError: undefined });
  });

  it("hydrate는 clientMsgId 기준 upsert — 이미 본 턴의 늦은 실패도 반영", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "q", status: "processing" }] },
      { type: "hydrate", sessionId: sid, turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "q", status: "failed", error: { code: "RESTARTED", retryable: true } }] },
    ]);
    expect(orderedTurns(s)[0]).toMatchObject({ status: "failed", error: { code: "RESTARTED" } });
  });

  it("[U8] terminal 턴은 늦은 processing hydrate로 되돌아가지 않지만 빈 질문 텍스트는 보충", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      done(1), // 다른 소켓에서 보낸 질문의 결과만 먼저 받음 → userText 비어 있음
      { type: "hydrate", sessionId: sid, turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "실제 질문", status: "processing" }] },
    ]);
    expect(orderedTurns(s)[0]).toMatchObject({ status: "completed", assistantText: "a", userText: "실제 질문" });
  });

  it("[U8] done 후 error가 와도 먼저 온 terminal 유지", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      done(1),
      { type: "error", e: { sessionId: sid, clientMsgId: cid(1), turnSeq: 1, code: "INTERNAL", message: "x", retryable: false } },
    ]);
    expect(orderedTurns(s)[0]).toMatchObject({ status: "completed", assistantText: "a" });
  });

  it("[U3] 다른 세션의 액션(localSend·ack·ackFailed·이벤트·trace)은 무시", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: other, clientMsgId: cid(1), text: "q" },
      { type: "ack", sessionId: other, clientMsgId: cid(2), turnId: "x", turnSeq: 1 },
      { type: "ackFailed", sessionId: other, clientMsgId: cid(3), error: uncertain },
      done(4, "x", other),
      { type: "trace", e: { sessionId: other, traceId: "trx", trace: {} } },
    ]);
    expect(orderedTurns(s)).toEqual([]);
    expect(s.traces).toEqual({});
  });

  it("확정 실패는 sendError(uncertain=false)로 남는다", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(1), text: "q" },
      { type: "ackFailed", sessionId: sid, clientMsgId: cid(1), error: { code: "QUEUE_FULL", message: "많음", retryable: true, uncertain: false } },
    ]);
    expect(orderedTurns(s)[0]?.sendError).toMatchObject({ code: "QUEUE_FULL", uncertain: false });
  });

  it("정렬: turnSeq 오름차순, seq 없는 로컬 전송은 뒤", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [{ turnId: "t2", turnSeq: 2, clientMsgId: cid(2), userText: "b", status: "processing" }, { turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "a", status: "processing" }] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(3), text: "c" },
    ]);
    expect(orderedTurns(s).map((t) => t.userText)).toEqual(["a", "b", "c"]);
  });

  it("trace는 같은 세션일 때 traceId로 보관", () => {
    const s = run([{ type: "hydrate", sessionId: sid, turns: [] }, { type: "trace", e: { sessionId: sid, traceId: "tr1", trace: { route: "faq" } } }]);
    expect(s.traces.tr1).toEqual({ route: "faq" });
  });
});

describe("syncStart", () => {
  const S = "00000000-0000-4000-8000-000000000001";
  it("sessionId가 같으면 state 그대로", () => {
    const s = turnsReducer(initialTurns, { type: "syncStart", sessionId: S });
    expect(s.sessionId).toBe(S);
    expect(turnsReducer(s, { type: "syncStart", sessionId: S })).toBe(s);
  });
  it("다르면 비우고 새 sessionId", () => {
    const s = { sessionId: "other", byClientId: { x: {} as never }, traces: { t: {} } };
    expect(turnsReducer(s, { type: "syncStart", sessionId: S })).toEqual({ sessionId: S, byClientId: {}, traces: {} });
  });
  it("먼저 반영된 done이 processing hydrate에 덮이지 않는다 [U8]", () => {
    const C = "00000000-0000-4000-8000-00000000aaaa";
    let s = turnsReducer(initialTurns, { type: "syncStart", sessionId: S });
    s = turnsReducer(s, { type: "done", e: { sessionId: S, clientMsgId: C, turnSeq: 1, turnId: "t1", text: "답", route: "faq", sources: [], traceId: "tr" } as never });
    s = turnsReducer(s, { type: "hydrate", sessionId: S, turns: [{ turnId: "t1", turnSeq: 1, clientMsgId: C, userText: "질", status: "processing" }] as never });
    expect(s.byClientId[C]).toMatchObject({ status: "completed", assistantText: "답", userText: "질" });
  });
});

describe("turnsReducer — 재전송 표시 [S2]", () => {
  const failed = { turnId: "t1", turnSeq: 1, clientMsgId: cid(1), userText: "q", status: "failed" as const, error: { code: "RESTARTED" as const, retryable: true } };
  it("localSend의 retryOfTurnSeq를 턴에 남기고 hydrate·done 뒤에도 유지한다", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [failed] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(2), text: "q", retryOfTurnSeq: 1 },
      done(2),
      { type: "hydrate", sessionId: sid, turns: [{ turnId: "t2", turnSeq: 2, clientMsgId: cid(2), userText: "q", status: "completed", assistantText: "a", route: "faq" }] },
    ]);
    expect(orderedTurns(s).map((t) => t.retryOfTurnSeq)).toEqual([undefined, 1]);
  });
  it("같은 clientMsgId 복구 재전송(retryOfTurnSeq 없음)은 기존 값을 지우지 않는다", () => {
    const s = run([
      { type: "hydrate", sessionId: sid, turns: [] },
      { type: "localSend", sessionId: sid, clientMsgId: cid(2), text: "q", retryOfTurnSeq: 1 },
      { type: "ackFailed", sessionId: sid, clientMsgId: cid(2), error: uncertain },
      { type: "localSend", sessionId: sid, clientMsgId: cid(2), text: "q" },
    ]);
    expect(orderedTurns(s)[0]?.retryOfTurnSeq).toBe(1);
  });
});
