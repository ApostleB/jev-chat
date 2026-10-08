import type { CompletedTurn } from "../domain/types";

export interface RecentTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ConversationContext {
  recentTurns: RecentTurn[];
  turnSeqs: number[];
  previousUserText: string | null;
  previousSourceTitles: string[];
}

export interface SearchQueries {
  faq: string;
  chunks: string[];
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("") + "…";
}

/** turns는 turnSeq 오름차순의 완료 턴. 마지막 maxTurns개만 문맥으로 쓴다. */
export function buildContext(
  turns: CompletedTurn[],
  opts: { maxTurns: number; assistantMaxChars: number },
): ConversationContext {
  const recent = turns.slice(-opts.maxTurns);
  const last = recent.at(-1);
  return {
    recentTurns: recent.flatMap((t) => [
      { role: "user" as const, text: t.userText },
      { role: "assistant" as const, text: truncate(t.assistantText, opts.assistantMaxChars) },
    ]),
    turnSeqs: recent.map((t) => t.turnSeq),
    previousUserText: last?.userText ?? null,
    previousSourceTitles: last?.sourceTitles ?? [],
  };
}

export function buildQueries(message: string, ctx: ConversationContext): SearchQueries {
  const q1 = message;
  if (ctx.previousUserText === null) return { faq: message, chunks: [q1] };
  const q2 = [message, ctx.previousUserText, ...ctx.previousSourceTitles].join(" ");
  return { faq: message, chunks: [q1, q2] };
}
