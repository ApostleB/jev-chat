import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminConfigSchema } from "@jev-chat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorText } from "@/lib/api";

/** 저장된 토큰 값은 다시 표시하지 않는다(존재 여부만). */
export function SettingsPage({ token, authEpoch, onSave, onLogout }: { token: string | null; authEpoch: number; onSave: (t: string) => void; onLogout: () => void }) {
  const [draft, setDraft] = useState("");
  const config = useQuery({
    queryKey: ["config", authEpoch],
    queryFn: () => api.get("/api/admin/config", AdminConfigSchema),
    enabled: !!token,
  });
  return (
    <div className="max-w-2xl space-y-4 p-4 text-sm">
      <p className="text-muted-foreground">{token ? "토큰이 저장되어 있습니다." : "저장된 토큰이 없습니다."}</p>
      <label className="block space-y-1">
        <span>접속 토큰</span>
        <Input type="password" aria-label="접속 토큰" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
      </label>
      <div className="flex gap-2">
        <Button onClick={() => { onSave(draft); setDraft(""); }} disabled={!draft.trim()}>저장</Button>
        {token && <Button variant="outline" onClick={onLogout}>로그아웃</Button>}
      </div>
      {token && config.isFetching && !config.data && <p className="text-muted-foreground">설정을 불러오는 중…</p>}
      {token && config.error && <p className="text-destructive">{errorText(config.error)}</p>}
      {token && config.data && <pre className="whitespace-pre-wrap rounded border p-3">{JSON.stringify(config.data, null, 2)}</pre>}
    </div>
  );
}
