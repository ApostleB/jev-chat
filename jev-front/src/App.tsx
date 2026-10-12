import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import type { IoFactory } from "@/lib/chat-client";
import { markAuthChanged } from "@/lib/auth-generation";
import { clearSessionId } from "@/lib/session-store";
import { clearToken, getToken, setToken } from "@/lib/token-store";
import { ChatPage } from "@/features/chat/ChatPage";
import { KnowledgePage } from "@/features/knowledge/KnowledgePage";
import { LogsPage } from "@/features/logs/LogsPage";
import { ReviewPage } from "@/features/review/ReviewPage";
import { SettingsPage } from "@/features/settings/SettingsPage";

const PAGES = ["테스트 채팅", "대화 로그", "검수 대기", "지식 데이터", "설정"] as const;
type Page = (typeof PAGES)[number];

export function App({ ioFactory }: { ioFactory?: IoFactory } = {}) {
  const queryClient = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [authEpoch, setAuthEpoch] = useState(0);
  const [page, setPage] = useState<Page>(() => (getToken() ? "테스트 채팅" : "설정"));
  // [U9] 채팅 세션은 App 수명 — 화면을 바꿔도 연결·대화가 유지된다
  const chat = useChat(token, authEpoch, ioFactory ? { ioFactory } : {});

  /** [U6] 인증이 바뀌면 진행 중 요청 취소 → 캐시 비움 → 세대 증가(채팅 연결 교체, 페이지 상태 초기화) */
  const resetAuth = () => {
    markAuthChanged(); // [F2] 진행 중 mutation의 늦은 UI 콜백 차단
    void queryClient.cancelQueries(); // signal이 fetch까지 전달되어 실제 요청이 abort된다
    queryClient.clear();
    setAuthEpoch((e) => e + 1);
  };
  const save = (t: string) => {
    setToken(t);
    setTokenState(getToken());
    resetAuth();
  };
  const logout = () => {
    clearToken();
    clearSessionId(); // [P2] 이전 사용자의 sessionId를 다음 로그인에 이어가지 않는다
    setTokenState(null);
    resetAuth();
    setPage("설정");
  };

  return (
    <TooltipProvider>
      <div className="grid h-screen grid-cols-[12rem_1fr]">
        <nav className="space-y-1 border-r p-3">
          {PAGES.map((p) => (
            <button key={p} type="button" onClick={() => setPage(p)} className={`block w-full rounded px-2 py-1 text-left text-sm ${page === p ? "bg-muted font-medium" : "hover:bg-muted"}`}>
              {p}
            </button>
          ))}
        </nav>
        <main className="flex h-screen flex-col overflow-hidden">
          <h1 className="border-b px-4 py-2 text-base font-semibold">{page}</h1>
          <div className="flex-1 overflow-auto" key={authEpoch}>
            {page === "테스트 채팅" && <ChatPage chat={chat} hasToken={!!token} />}
            {page === "대화 로그" && <LogsPage enabled={!!token} authEpoch={authEpoch} />}
            {page === "검수 대기" && <ReviewPage enabled={!!token} authEpoch={authEpoch} />}
            {page === "지식 데이터" && <KnowledgePage enabled={!!token} authEpoch={authEpoch} />}
            {page === "설정" && <SettingsPage token={token} authEpoch={authEpoch} onSave={save} onLogout={logout} />}
          </div>
        </main>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
