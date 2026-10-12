import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatHandle } from "@/hooks/use-chat";
import type { UiTurn } from "@/lib/turns";
import { JudgmentPanel } from "../judgment/JudgmentPanel";
import { ChatThread } from "./ChatThread";
import { Composer } from "./Composer";

function statusText(chat: ChatHandle): string {
  if (chat.conn.kind === "rejected") {
    return chat.conn.code === "PROTOCOL_UNSUPPORTED" ? "서버 버전이 다릅니다. 화면을 새로고침하세요." : "연결이 거부되었습니다. 설정에서 토큰을 확인하세요.";
  }
  if (chat.conn.kind === "disconnected") return "연결 끊김 — 재연결 중";
  if (chat.conn.kind === "connecting") return "연결 중";
  if (chat.session.kind === "syncing") return "대화 동기화 중";
  if (chat.session.kind === "error") return `대화를 불러오지 못했습니다 (${chat.session.code})`;
  if (chat.session.kind === "ready") return "연결됨";
  return "대기";
}

export function ChatPage({ chat, hasToken }: { chat: ChatHandle; hasToken: boolean }) {
  const [selected, setSelected] = useState<UiTurn | null>(null);
  if (!hasToken) return <p className="p-6 text-sm">설정 화면에서 접속 토큰을 먼저 입력하세요.</p>;
  const trace = selected?.traceId ? chat.state.traces[selected.traceId] : undefined;
  const needsReconnect = chat.conn.kind === "rejected" || chat.session.kind === "error";
  return (
    <div className="grid h-full grid-cols-[1fr_24rem]">
      <section className="flex h-full flex-col border-r">
        <header className="flex items-center justify-between border-b p-3 text-sm">
          <span>{statusText(chat)}</span>
          <div className="flex gap-2">
            {needsReconnect && <Button size="sm" onClick={chat.reconnect}>다시 연결</Button>}
            {chat.history.nextBeforeTurnSeq !== null && <Button size="sm" variant="ghost" onClick={() => void chat.loadOlder()}>이전 대화</Button>}
            <Button size="sm" variant="outline" onClick={() => { setSelected(null); void chat.newSession(); }} disabled={chat.session.kind !== "ready"}>새 세션</Button>
          </div>
        </header>
        <ScrollArea className="flex-1 p-4">
          <ChatThread turns={chat.turns} onRetry={(t) => void chat.retry(t).catch(() => undefined)} onSelect={setSelected} />
        </ScrollArea>
        <div className="border-t p-3">
          <Composer onSend={chat.send} disabled={chat.session.kind !== "ready"} />
        </div>
      </section>
      <aside className="overflow-y-auto">
        <JudgmentPanel trace={trace} />
        {selected?.traceId && !trace && <p className="px-4 text-xs text-muted-foreground">이 답변의 trace는 대화 로그 화면에서 볼 수 있습니다(debug 권한 필요).</p>}
      </aside>
    </div>
  );
}
