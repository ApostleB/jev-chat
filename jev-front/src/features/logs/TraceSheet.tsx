import { useQuery } from "@tanstack/react-query";
import { TraceDetailSchema } from "@jev-chat/protocol";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, errorText } from "@/lib/api";
import { JudgmentPanel } from "../judgment/JudgmentPanel";

const VERDICT: Record<string, string> = { correct: "맞음", wrong: "틀림", partial: "부분" };

/** 읽기 전용 trace 서랍(전송 UI 없음). [P3] 서버 텍스트는 모두 일반 텍스트로 렌더링한다. */
export function TraceSheet({ traceId, authEpoch, onClose }: { traceId: string | null; authEpoch: number; onClose: () => void }) {
  const trace = useQuery({
    queryKey: ["trace", authEpoch, traceId],
    queryFn: ({ signal }) => api.get(`/api/traces/${encodeURIComponent(traceId!)}`, TraceDetailSchema, { signal }),
    enabled: !!traceId,
  });
  return (
    <Sheet open={!!traceId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>판단 trace</SheetTitle>
          <SheetDescription>읽기 전용</SheetDescription>
        </SheetHeader>
        {trace.isFetching && !trace.data && <p className="px-4 text-sm text-muted-foreground">불러오는 중…</p>}
        {trace.error && <p className="px-4 text-sm text-destructive">{errorText(trace.error)}</p>}
        {trace.data && (
          <>
            <JudgmentPanel trace={trace.data.data} />
            <section className="space-y-2 px-4 pb-4 text-sm">
              <h3 className="font-medium">검수 이력</h3>
              {trace.data.reviews.length === 0 && <p className="text-muted-foreground">검수 이력이 없습니다.</p>}
              <ul className="space-y-2">
                {trace.data.reviews.map((r) => (
                  <li key={r.id} className="rounded border p-2">
                    <div>{VERDICT[r.verdict] ?? r.verdict} · {r.reviewerId} · {r.createdAt}</div>
                    {r.expectedIntent && <div>정답 의도: {r.expectedIntent}</div>}
                    {r.expectedFaqId && <div>정답 FAQ: {r.expectedFaqId}</div>}
                    {r.expectedChunkIds && r.expectedChunkIds.length > 0 && <div>정답 청크: {r.expectedChunkIds.join(", ")}</div>}
                    {r.note && <p className="whitespace-pre-wrap">{r.note}</p>}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
