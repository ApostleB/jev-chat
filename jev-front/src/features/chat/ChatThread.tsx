import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { UiTurn } from "@/lib/turns";

const STAGE: Record<string, string> = { queued: "대기 중", judging: "판단 중", answering: "답변 작성 중" };

function problemOf(t: UiTurn): { message: string; retryable: boolean } | null {
  if (t.sendError) return { message: t.sendError.message, retryable: t.sendError.retryable };
  if (t.error && (t.status === "failed" || t.route === "error")) return { message: t.error.code, retryable: t.error.retryable };
  return null;
}

export function ChatThread({ turns, onRetry, onSelect }: { turns: UiTurn[]; onRetry: (t: UiTurn) => void; onSelect: (t: UiTurn) => void }) {
  return (
    <ol className="space-y-4">
      {turns.map((t) => {
        const problem = problemOf(t);
        return (
          <li key={t.clientMsgId} className="space-y-2">
            <div className="ml-auto w-fit max-w-[80%] rounded-lg bg-primary px-3 py-2 text-primary-foreground whitespace-pre-wrap">{t.userText}</div>
            {t.status === "processing" && !t.sendError && <p className="text-xs text-muted-foreground">{STAGE[t.stage ?? "queued"]}…</p>}
            {t.status === "completed" && (
              <button type="button" onClick={() => onSelect(t)} className="block w-fit max-w-[85%] rounded-lg border px-3 py-2 text-left hover:bg-muted">
                <div className="mb-1 flex gap-1"><Badge variant="secondary">{t.route}</Badge></div>
                <div className="whitespace-pre-wrap">{t.assistantText}</div>
                {(t.sources ?? []).length > 0 && (
                  <ul className="mt-2 text-xs text-muted-foreground">
                    {t.sources!.map((s) => <li key={s.chunkId}>{`${s.title} · ${s.section}`}</li>)}
                  </ul>
                )}
              </button>
            )}
            {problem && (
              <div className="flex items-center gap-2 text-xs text-destructive">
                <span>{problem.message}</span>
                {problem.retryable && <Button size="sm" variant="outline" onClick={() => onRetry(t)}>다시 보내기</Button>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
