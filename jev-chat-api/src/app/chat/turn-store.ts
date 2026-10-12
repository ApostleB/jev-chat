import type { TurnRepository } from "../../adapters/persistence/turn.repository";

export type TurnStore = Pick<
  TurnRepository,
  "findSession" | "createSession" | "findTurnByClientMsgId" | "reserveTurn" | "completeTurn" | "failTurn" | "listTurns" | "loadCompletedTurns"
>;
export const TURN_STORE = Symbol("TURN_STORE");
