import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function Composer({ onSend, disabled }: { onSend: (text: string) => Promise<void>; disabled: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (sending || disabled || !text.trim()) return; // 전송 중 재제출 금지
    const sent = text;
    setSending(true);
    setError(null);
    try {
      await onSend(sent);
      setText((cur) => (cur === sent ? "" : cur)); // 그 사이 편집한 초안은 보존
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="HB-ERP 규정이나 사용법을 물어보세요 (Shift+Enter 줄바꿈)"
          disabled={disabled}
        />
        <Button onClick={() => void submit()} disabled={disabled || sending || !text.trim()}>보내기</Button>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="text-destructive">{error}</span>
        <span>{[...text].length} / 1000</span>
      </div>
    </div>
  );
}
