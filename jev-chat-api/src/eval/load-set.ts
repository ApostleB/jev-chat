import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PackValidationError, type DomainPack } from "../adapters/knowledge/pack-loader";
import { EvalItemSchema, type EvalItem } from "./eval-item";

/** 오류 메시지에는 위치·ID만 넣고 항목 본문은 넣지 않는다(holdout 노출 방지). */
export async function loadEvalSet(file: string, pack: DomainPack): Promise<EvalItem[]> {
  const name = basename(file);
  const faqIds = new Set(pack.faqs.map((f) => f.id));
  const chunkIds = new Set(pack.chunks.map((c) => c.id));
  const issues: string[] = [];
  const items: EvalItem[] = [];
  const seen = new Set<string>();
  (await readFile(file, "utf8")).split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${name}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      issues.push(`${where}: JSON 형식 오류`);
      return;
    }
    const parsed = EvalItemSchema.safeParse(json);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((x) => `${where} [${x.path.join(".")}]: ${x.message}`));
      return;
    }
    const it = parsed.data;
    if (seen.has(it.id)) issues.push(`${where}: 중복 ID ${it.id}`);
    seen.add(it.id);
    const e = it.expect;
    for (const id of [...(e.faq_ids ?? []), ...(e.attack_goal && "faq_id" in e.attack_goal ? [e.attack_goal.faq_id] : [])]) {
      if (!faqIds.has(id)) issues.push(`${where}: 팩에 없는 FAQ ${id}`);
    }
    for (const id of [...(e.acceptable_chunk_ids ?? []), ...(e.required_chunk_ids_any ?? []), ...it.turns.flatMap((t) => t.sources ?? [])]) {
      if (!chunkIds.has(id)) issues.push(`${where}: 팩에 없는 청크 ${id}`);
    }
    items.push(it);
  });
  if (issues.length) throw new PackValidationError(issues);
  return items;
}
