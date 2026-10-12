import { useState } from "react";
import type { ReviewRequest } from "@jev-chat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const VERDICTS = [
  { value: "correct", label: "맞음" },
  { value: "wrong", label: "틀림" },
  { value: "partial", label: "부분" },
] as const;

export function ReviewForm({ onSubmit }: { onSubmit: (r: ReviewRequest) => Promise<void> }) {
  const [verdict, setVerdict] = useState<ReviewRequest["verdict"] | null>(null);
  const [intent, setIntent] = useState("");
  const [faq, setFaq] = useState("");
  const [chunks, setChunks] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!verdict || submitting) return;
    const ids = chunks.split(",").map((s) => s.trim()).filter(Boolean);
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        verdict,
        ...(intent.trim() ? { expectedIntent: intent.trim() } : {}),
        ...(faq.trim() ? { expectedFaqId: faq.trim() } : {}),
        ...(ids.length ? { expectedChunkIds: ids } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="space-y-3 text-sm" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <fieldset className="flex gap-4">
        <legend className="mb-1 font-medium">판정</legend>
        {VERDICTS.map((v) => (
          <label key={v.value} className="flex items-center gap-1">
            <input type="radio" name="verdict" value={v.value} checked={verdict === v.value} onChange={() => setVerdict(v.value)} />
            {v.label}
          </label>
        ))}
      </fieldset>
      <label className="block">정답 의도<Input value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="정답 의도" maxLength={30} /></label>
      <label className="block">정답 FAQ ID<Input value={faq} onChange={(e) => setFaq(e.target.value)} aria-label="정답 FAQ ID" maxLength={100} /></label>
      <label className="block">정답 청크 ID<Input value={chunks} onChange={(e) => setChunks(e.target.value)} aria-label="정답 청크 ID" placeholder="card-002, card-003" /></label>
      <label className="block">메모<Textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="메모" maxLength={2000} /></label>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button type="submit" disabled={!verdict || submitting}>검수 저장</Button>
    </form>
  );
}
