import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toTraceView } from "@/lib/trace-view";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)}ms`);

export function JudgmentPanel({ trace }: { trace: unknown }) {
  const v = trace === undefined ? null : toTraceView(trace);
  if (!v) return <p className="p-4 text-sm text-muted-foreground">답변을 선택하면 Jev 판단 내용을 보여줍니다.</p>;
  return (
    <div className="space-y-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{v.route}</Badge>
        <Badge variant="outline">B: {v.bStatus}</Badge>
        <span className="text-muted-foreground">토큰 {v.totalInputTokens ?? "—"}</span>
      </div>
      <Card>
        <CardHeader className="py-2"><CardTitle className="text-sm">의도</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {v.intents.map((i) => (
            <div key={i.id} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2">
              <span>{i.id}</span>
              <Progress value={i.prob * 100} />
              <span className="text-right tabular-nums">{pct(i.prob)}</span>
            </div>
          ))}
          <div className="pt-1 text-muted-foreground">in_scope {pct(v.inScope)} · ambiguity {pct(v.ambiguity)} · manipulation {pct(v.manipulation)}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="py-2"><CardTitle className="text-sm">FAQ 후보 (선택: {v.faqChoice ?? "—"})</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {v.faqCandidates.map((c) => (
            <div key={c.id} className="flex justify-between gap-2"><span>#{c.rank} {c.id}</span><span className="tabular-nums">{pct(c.prob)}</span></div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="py-2"><CardTitle className="text-sm">문서 후보 (BM25 순위 → Jev 관련도)</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {v.chunkCandidates.map((c) => (
            <div key={c.id} className="grid grid-cols-[3rem_1fr_4rem_5rem] gap-2">
              <span>#{c.rank}</span><span>{c.id}</span>
              <span className="text-right tabular-nums">{c.relevance === null ? "—" : c.relevance.toFixed(2)}</span>
              <span className="text-right text-muted-foreground">{c.status}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {v.latency && (
        <p className="text-muted-foreground">
          검색 {ms(v.latency.retrieval)} · 판단 {ms(v.latency.turn)} · 관련도 {ms(v.latency.relevance)} · 전체 {ms(v.latency.total)}
        </p>
      )}
    </div>
  );
}
