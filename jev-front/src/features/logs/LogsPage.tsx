import { useInfiniteQuery } from "@tanstack/react-query";
import { SessionSummarySchema, TurnPageSchema, RouteSchema, type SessionSummary } from "@jev-chat/protocol";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorText } from "@/lib/api";
import { useCursorList } from "@/lib/use-cursor-list";
import { TraceSheet } from "./TraceSheet";

const ROUTES = RouteSchema.options;
const ALL = "all";

/** 대화 로그는 읽기 전용이다(전송 UI 없음). [P3] 세션 목록은 서버 정렬 그대로이며 '마지막 활동'은 표시만 한다. [P5] */
export function LogsPage({ enabled, authEpoch }: { enabled: boolean; authEpoch: number }) {
  const [route, setRoute] = useState<string>(ALL);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const sessions = useCursorList({ key: "sessions", authEpoch, path: "/api/sessions", params: route === ALL ? {} : { route }, item: SessionSummarySchema, enabled });
  const sid = session?.id ?? null;
  const turns = useInfiniteQuery({
    queryKey: ["turns", authEpoch, sid],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api.get(`/api/sessions/${encodeURIComponent(sid!)}/turns${pageParam ? `?beforeTurnSeq=${pageParam}` : ""}`, TurnPageSchema),
    getNextPageParam: (last) => (last.hasMore ? (last.nextBeforeTurnSeq ?? undefined) : undefined),
    enabled: enabled && !!sid,
  });
  if (!enabled) return <p className="p-6 text-sm">토큰을 먼저 입력하세요.</p>;
  // 페이지는 최신 → 과거 순으로 받으므로 뒤집어 turn_seq 오름차순으로 이어 붙인다(각 페이지 내부는 서버 순서 그대로)
  const turnList = turns.data ? [...turns.data.pages].reverse().flatMap((p) => p.turns) : [];
  return (
    <div className="grid h-full grid-cols-[1fr_1fr] divide-x text-sm">
      <section className="space-y-3 overflow-auto p-4">
        <div className="flex items-center gap-2">
          <Select value={route} onValueChange={(v) => v && setRoute(v)} items={{ [ALL]: "전체 route", ...Object.fromEntries(ROUTES.map((r) => [r, r])) }}>
            <SelectTrigger aria-label="route 필터"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>전체 route</SelectItem>
              {ROUTES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {sessions.error && <p className="text-destructive">{errorText(sessions.error)}</p>}
        {sessions.isSuccess && sessions.items.length === 0 && <p className="text-muted-foreground">세션이 없습니다.</p>}
        {sessions.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow><TableHead>시작</TableHead><TableHead>마지막 활동</TableHead><TableHead>사용자</TableHead><TableHead>턴 수</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {sessions.items.map((s) => (
                <TableRow key={s.id} data-state={s.id === sid ? "selected" : undefined}>
                  <TableCell>{s.createdAt}</TableCell>
                  <TableCell>{s.lastActiveAt}</TableCell>
                  <TableCell><button type="button" className="underline" onClick={() => { setSession(s); setTraceId(null); }}>{s.userId}</button></TableCell>
                  <TableCell>{s.turnCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {sessions.hasNextPage && <Button variant="outline" size="sm" disabled={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()}>더 보기</Button>}
      </section>
      <section className="space-y-3 overflow-auto p-4">
        {!session && <p className="text-muted-foreground">세션을 선택하세요.</p>}
        {session && (
          <>
            <h2 className="font-medium">{session.userId} · 턴 {session.turnCount}</h2>
            {turns.error && <p className="text-destructive">{errorText(turns.error)}</p>}
            {turns.hasNextPage && <Button variant="outline" size="sm" disabled={turns.isFetchingNextPage} onClick={() => void turns.fetchNextPage()}>이전 턴 더 보기</Button>}
            <ol className="space-y-3">
              {turnList.map((t) => (
                <li key={t.clientMsgId} className="space-y-1 rounded border p-2">
                  <div className="whitespace-pre-wrap">{t.userText}</div>
                  {t.assistantText !== undefined && <div className="whitespace-pre-wrap text-muted-foreground">{t.assistantText}</div>}
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{t.status}</Badge>
                    {t.route && <Badge variant="outline">{t.route}</Badge>}
                    {t.traceId && <Button size="sm" variant="ghost" aria-label={`trace 보기 (턴 ${t.turnSeq})`} onClick={() => setTraceId(t.traceId!)}>trace 보기</Button>}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
      <TraceSheet traceId={traceId} authEpoch={authEpoch} onClose={() => setTraceId(null)} />
    </div>
  );
}
