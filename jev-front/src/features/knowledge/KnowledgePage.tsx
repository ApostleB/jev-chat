import { useMutation } from "@tanstack/react-query";
import { KnowledgeChunkItemSchema, KnowledgeFaqItemSchema, ReloadResponseSchema } from "@jev-chat/protocol";
import { toast } from "sonner";
import { captureAuthGeneration } from "@/lib/auth-generation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorText } from "@/lib/api";
import { useCursorList } from "@/lib/use-cursor-list";

function FaqTab({ enabled, authEpoch }: { enabled: boolean; authEpoch: number }) {
  const list = useCursorList({ key: "knowledge-faqs", authEpoch, path: "/api/knowledge/faqs", item: KnowledgeFaqItemSchema, enabled });
  return (
    <div className="space-y-2">
      {list.error && <p className="text-destructive">{errorText(list.error)}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>의도</TableHead><TableHead>요약</TableHead><TableHead>답변</TableHead><TableHead>근거 청크</TableHead><TableHead>변형 문장</TableHead></TableRow></TableHeader>
        <TableBody>
          {list.items.map((f) => (
            <TableRow key={f.id}>
              <TableCell>{f.id}</TableCell><TableCell>{f.intent}</TableCell>
              <TableCell className="whitespace-pre-wrap">{f.summary}</TableCell>
              <TableCell className="whitespace-pre-wrap">{f.answer}</TableCell>
              <TableCell>{f.sourceChunkId ?? "—"}</TableCell>
              <TableCell className="whitespace-pre-wrap">{f.variants.join("\n")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {list.hasNextPage && <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>더 보기</Button>}
    </div>
  );
}

function ChunkTab({ enabled, authEpoch }: { enabled: boolean; authEpoch: number }) {
  const list = useCursorList({ key: "knowledge-chunks", authEpoch, path: "/api/knowledge/chunks", item: KnowledgeChunkItemSchema, enabled });
  return (
    <div className="space-y-2">
      {list.error && <p className="text-destructive">{errorText(list.error)}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>모듈</TableHead><TableHead>종류</TableHead><TableHead>제목</TableHead><TableHead>절</TableHead><TableHead>본문</TableHead></TableRow></TableHeader>
        <TableBody>
          {list.items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.id}</TableCell><TableCell>{c.module}</TableCell><TableCell>{c.kind}</TableCell><TableCell>{c.title}</TableCell><TableCell>{c.section}</TableCell>
              <TableCell className="whitespace-pre-wrap">{c.text}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {list.hasNextPage && <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>더 보기</Button>}
    </div>
  );
}

export function KnowledgePage({ enabled, authEpoch }: { enabled: boolean; authEpoch: number }) {
  const reload = useMutation({
    mutationFn: () => api.post("/api/admin/knowledge/reload", undefined, ReloadResponseSchema),
    onMutate: () => ({ isCurrent: captureAuthGeneration() }),
    onSuccess: (r, _v, ctx) => {
      if (ctx?.isCurrent()) toast(r.changed ? "새 버전을 적용했습니다." : "변경 사항이 없습니다."); // [F2] 인증 세대가 지났으면 무시
    },
    onError: (e, _v, ctx) => {
      if (ctx?.isCurrent()) toast.error(errorText(e));
    },
  });
  if (!enabled) return <p className="p-6 text-sm">토큰을 먼저 입력하세요.</p>;
  return (
    <div className="space-y-3 p-4 text-sm">
      <Button variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>활성 지식 인덱스 다시 로드</Button>
      <Tabs defaultValue="faq">
        <TabsList>
          <TabsTrigger value="faq">FAQ</TabsTrigger>
          <TabsTrigger value="chunk">청크</TabsTrigger>
        </TabsList>
        <TabsContent value="faq"><FaqTab enabled={enabled} authEpoch={authEpoch} /></TabsContent>
        <TabsContent value="chunk"><ChunkTab enabled={enabled} authEpoch={authEpoch} /></TabsContent>
      </Tabs>
    </div>
  );
}
