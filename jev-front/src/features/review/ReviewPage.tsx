import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ReviewQueueItemSchema, ReviewSchema, type ReviewQueueItem, type ReviewRequest } from "@jev-chat/protocol";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { useCursorList } from "@/lib/use-cursor-list";
import { ReviewForm } from "./ReviewForm";

export function ReviewPage({ enabled, authEpoch }: { enabled: boolean; authEpoch: number }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReviewQueueItem | null>(null);
  const queue = useCursorList({ key: "reviews", authEpoch, path: "/api/reviews/queue", item: ReviewQueueItemSchema, enabled });
  const save = useMutation({
    mutationFn: (r: ReviewRequest) => api.post(`/api/traces/${encodeURIComponent(selected!.traceId)}/review`, r, ReviewSchema),
    onSuccess: () => {
      toast.success("검수를 저장했습니다.");
      return queryClient.invalidateQueries({ queryKey: ["reviews", authEpoch] });
    },
  });
  if (!enabled) return <p className="p-6 text-sm">토큰을 먼저 입력하세요.</p>;
  const onSubmit = async (r: ReviewRequest) => {
    try {
      await save.mutateAsync(r);
    } catch (e) {
      throw new Error(errorText(e)); // 서버 원문 대신 안전한 안내 문구
    }
  };
  return (
    <div className="grid h-full grid-cols-[1fr_24rem] divide-x text-sm">
      <section className="space-y-2 overflow-auto p-4">
        {queue.error && <p className="text-destructive">{errorText(queue.error)}</p>}
        {queue.isSuccess && queue.items.length === 0 && <p className="text-muted-foreground">검수 대기 항목이 없습니다.</p>}
        <ul className="space-y-2">
          {queue.items.map((it) => (
            <li key={it.traceId}>
              <button type="button" onClick={() => setSelected(it)} className={`block w-full rounded border p-2 text-left hover:bg-muted ${selected?.traceId === it.traceId ? "bg-muted" : ""}`}>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{it.route}</Badge>
                  {it.intent && <Badge variant="secondary">{it.intent}</Badge>}
                  {it.reviewed && <Badge>검수 완료</Badge>}
                </div>
                <div className="whitespace-pre-wrap">{it.userText}</div>
                {it.assistantText !== null && <div className="whitespace-pre-wrap text-muted-foreground">{it.assistantText}</div>}
              </button>
            </li>
          ))}
        </ul>
        {queue.hasNextPage && <Button variant="outline" size="sm" disabled={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>더 보기</Button>}
      </section>
      <aside className="overflow-auto p-4">
        {selected ? <ReviewForm key={selected.traceId} onSubmit={onSubmit} /> : <p className="text-muted-foreground">항목을 선택하세요.</p>}
      </aside>
    </div>
  );
}
