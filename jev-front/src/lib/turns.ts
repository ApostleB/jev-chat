import type { ChatDoneEvent, ChatErrorEvent, ChatStatusEvent, ChatTraceEvent, ErrorCode, Turn } from "@jev-chat/protocol";

/** [U2] uncertain=true: ack를 받지 못해 서버 수락 여부를 모름 → 같은 clientMsgId로 복구 재전송 */
export interface SendError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  uncertain: boolean;
}

export type UiTurn = Turn & {
  localId: string;
  stage?: "queued" | "judging" | "answering";
  sendError?: SendError;
};

export interface TurnsState {
  sessionId: string | null;
  byClientId: Record<string, UiTurn>;
  traces: Record<string, Record<string, unknown>>;
}

export type TurnsAction =
  | { type: "syncStart"; sessionId: string }
  | { type: "hydrate"; sessionId: string; turns: Turn[] }
  | { type: "localSend"; sessionId: string; clientMsgId: string; text: string }
  | { type: "ack"; sessionId: string; clientMsgId: string; turnId: string; turnSeq: number }
  | { type: "ackFailed"; sessionId: string; clientMsgId: string; error: SendError }
  | { type: "status"; e: ChatStatusEvent }
  | { type: "done"; e: ChatDoneEvent }
  | { type: "error"; e: ChatErrorEvent }
  | { type: "trace"; e: ChatTraceEvent }
  | { type: "reset" };

export const initialTurns: TurnsState = { sessionId: null, byClientId: {}, traces: {} };

const isTerminal = (t: { status: string }) => t.status === "completed" || t.status === "failed";
let localCounter = 0;

function blank(clientMsgId: string): UiTurn {
  return { localId: `l${++localCounter}`, turnId: "", turnSeq: 0, clientMsgId, userText: "", status: "processing" };
}

function put(state: TurnsState, clientMsgId: string, patch: (t: UiTurn) => UiTurn): TurnsState {
  const prev = state.byClientId[clientMsgId] ?? blank(clientMsgId);
  return { ...state, byClientId: { ...state.byClientId, [clientMsgId]: patch(prev) } };
}

/** 로컬 전용 표시(진행 단계·전송 오류) 제거 — 서버 terminal 결과가 우선한다 [U2] */
function stripLocal(t: UiTurn): UiTurn {
  // 키를 지우지 않고 undefined로 둔다(키 존재와 무관하게 "없음"을 뜻함)
  return { ...t, stage: undefined, sendError: undefined };
}

/** [U8] 비어 있는 메타데이터만 보충 */
function fillMeta(prev: UiTurn, t: { turnId?: string; turnSeq?: number; userText?: string }): UiTurn {
  return { ...prev, turnId: prev.turnId || t.turnId || "", turnSeq: prev.turnSeq || t.turnSeq || 0, userText: prev.userText || t.userText || "" };
}

export function turnsReducer(state: TurnsState, a: TurnsAction): TurnsState {
  switch (a.type) {
    case "reset":
      return initialTurns;
    case "syncStart":
      // resume session:start 전에 대상 세션을 먼저 알려, ack 전에 온 같은 세션의 done/error/trace를 받는다
      return state.sessionId === a.sessionId ? state : { ...initialTurns, sessionId: a.sessionId };
    case "hydrate": {
      let s: TurnsState = state.sessionId === a.sessionId ? state : { ...initialTurns, sessionId: a.sessionId };
      for (const t of a.turns) {
        s = put(s, t.clientMsgId, (prev) => {
          if (isTerminal(prev) && !isTerminal(t)) return fillMeta(prev, t); // [U8]
          const merged: UiTurn = { ...prev, ...t, localId: prev.localId };
          return isTerminal(t) ? stripLocal(merged) : merged;
        });
      }
      return s;
    }
    case "localSend":
      if (a.sessionId !== state.sessionId) return state; // [U3]
      return put(state, a.clientMsgId, (prev) =>
        isTerminal(prev) ? prev : { ...stripLocal(prev), userText: a.text, status: "processing", stage: "queued" },
      );
    case "ack":
      if (a.sessionId !== state.sessionId) return state;
      return put(state, a.clientMsgId, (prev) => ({ ...prev, turnId: prev.turnId || a.turnId, turnSeq: prev.turnSeq || a.turnSeq }));
    case "ackFailed":
      if (a.sessionId !== state.sessionId) return state;
      // [U2] 이미 terminal이면(예: done이 먼저 옴) ack 실패는 의미가 없다
      return put(state, a.clientMsgId, (prev) => (isTerminal(prev) ? prev : { ...prev, sendError: a.error, stage: undefined }));
    case "status":
      if (a.e.sessionId !== state.sessionId) return state;
      // status는 서버가 수락했다는 증거 → 미확정 오류 해제 [U2]
      return put(state, a.e.clientMsgId, (prev) =>
        isTerminal(prev) ? prev : { ...prev, turnSeq: a.e.turnSeq, stage: a.e.stage, sendError: undefined },
      );
    case "done":
      if (a.e.sessionId !== state.sessionId) return state;
      return put(state, a.e.clientMsgId, (prev) => {
        if (isTerminal(prev)) return fillMeta(prev, { turnId: a.e.turnId, turnSeq: a.e.turnSeq }); // [U8]
        return stripLocal({
          ...prev,
          turnId: a.e.turnId,
          turnSeq: a.e.turnSeq,
          status: "completed",
          assistantText: a.e.text,
          route: a.e.route,
          sources: a.e.sources,
          traceId: a.e.traceId,
          ...(a.e.error ? { error: a.e.error } : {}),
        });
      });
    case "error":
      if (a.e.sessionId !== state.sessionId) return state;
      return put(state, a.e.clientMsgId, (prev) => {
        if (isTerminal(prev)) return fillMeta(prev, { turnSeq: a.e.turnSeq }); // [U8]
        return stripLocal({ ...prev, turnSeq: a.e.turnSeq, status: "failed", error: { code: a.e.code, retryable: a.e.retryable } });
      });
    case "trace":
      // [U3 재확인] 서버가 붙인 원 sessionId로 판단한다(현재 세션으로 라벨을 붙이지 않음)
      if (a.e.sessionId !== state.sessionId) return state;
      return { ...state, traces: { ...state.traces, [a.e.traceId]: a.e.trace } };
  }
}

export function orderedTurns(state: TurnsState): UiTurn[] {
  const all = Object.values(state.byClientId);
  const seq = all.filter((t) => t.turnSeq > 0).sort((a, b) => a.turnSeq - b.turnSeq);
  const pending = all.filter((t) => t.turnSeq === 0).sort((a, b) => Number(a.localId.slice(1)) - Number(b.localId.slice(1)));
  return [...seq, ...pending];
}
