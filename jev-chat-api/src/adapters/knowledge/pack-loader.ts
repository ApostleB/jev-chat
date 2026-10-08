import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { TEMPLATE_VERSION, type Chunk, type Faq, type Helpdesk, type IntentDef, type Policy } from "../../core";
import { ChunkLineSchema, FaqLineSchema, IntentsSchema, ManifestSchema, PolicySchema } from "./pack-schema";

export interface DomainPack {
  manifest: { name: string; version: string; language: string; helpdesk: Helpdesk; templateVersion: string };
  policy: Policy;
  intents: IntentDef[];
  chunks: Chunk[];
  faqs: Faq[];
  contentHash: string;
}

export class PackValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`domain-pack 검증 실패\n${issues.join("\n")}`);
    this.name = "PackValidationError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function zodIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}${i.path.length ? ` [${i.path.join(".")}]` : ""}: ${i.message}`);
}

async function readYaml<T>(dir: string, file: string, schema: z.ZodType<T>, issues: string[]): Promise<T | null> {
  const raw = parseYaml(await readFile(join(dir, file), "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    issues.push(...zodIssues(file, parsed.error));
    return null;
  }
  return parsed.data;
}

async function readJsonl<T>(dir: string, file: string, schema: z.ZodType<T>, issues: string[]): Promise<T[]> {
  const lines = (await readFile(join(dir, file), "utf8")).split("\n");
  const out: T[] = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const where = `${file}:${idx + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      issues.push(`${where}: JSON 형식 오류`);
      return;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
    else issues.push(...zodIssues(where, parsed.error));
  });
  return out;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
}

export async function loadDomainPack(dir: string): Promise<DomainPack> {
  const issues: string[] = [];
  const manifest = await readYaml(dir, "manifest.yaml", ManifestSchema, issues);
  const policy = await readYaml(dir, "policy.yaml", PolicySchema, issues);
  const intents = await readYaml(dir, "intents.yaml", IntentsSchema, issues);
  const chunkLines = await readJsonl(dir, "chunks.jsonl", ChunkLineSchema, issues);
  const faqLines = await readJsonl(dir, "faqs.jsonl", FaqLineSchema, issues);

  if (manifest && manifest.template_version !== TEMPLATE_VERSION) {
    issues.push(`manifest.yaml: template_version ${manifest.template_version}이 코드의 ${TEMPLATE_VERSION}와 다릅니다.`);
  }
  for (const id of duplicates(chunkLines.map((c) => c.id))) issues.push(`chunks.jsonl: 중복 ID ${id}`);
  for (const id of duplicates(faqLines.map((f) => f.id))) issues.push(`faqs.jsonl: 중복 ID ${id}`);
  const chunkIds = new Set(chunkLines.map((c) => c.id));
  for (const f of faqLines) {
    if (f.source_chunk_id && !chunkIds.has(f.source_chunk_id)) issues.push(`faqs.jsonl: ${f.id}의 source_chunk_id ${f.source_chunk_id}가 없습니다.`);
  }
  if (issues.length > 0 || !manifest || !policy || !intents) throw new PackValidationError(issues);

  const chunks: Chunk[] = chunkLines.map((c) => ({
    id: c.id,
    module: c.module,
    kind: c.kind,
    title: c.title,
    section: c.section,
    text: c.text,
    tags: c.tags,
    updatedAt: c.updated_at,
    contentHash: sha256(JSON.stringify([c.title, c.section, c.text, c.kind])),
  }));
  const faqs: Faq[] = faqLines.map((f) => ({
    id: f.id,
    intent: f.intent,
    summary: f.summary,
    appliesWhen: f.applies_when,
    answer: f.answer,
    sourceChunkId: f.source_chunk_id,
    variants: f.variants,
  }));
  const packManifest = {
    name: manifest.name,
    version: manifest.version,
    language: manifest.language,
    helpdesk: manifest.helpdesk.url ? manifest.helpdesk : { phone: manifest.helpdesk.phone, email: manifest.helpdesk.email },
    templateVersion: manifest.template_version,
  };
  const packPolicy: Policy = {
    inScope: policy.in_scope,
    ambiguous: policy.ambiguous,
    faq: policy.faq,
    relevance: policy.relevance,
    helpdesk: policy.helpdesk,
    candidates: policy.candidates,
    context: { maxTurns: policy.context.max_turns, assistantMaxChars: policy.context.assistant_max_chars },
    deadlines: {
      engineMs: policy.deadlines.engine_ms,
      queueMs: policy.deadlines.queue_ms,
      limiterMs: 0, // [P10] 서버 설정값으로 SnapshotService가 채운다
      saveMs: policy.deadlines.save_ms,
    },
  };
  const contentHash = sha256(JSON.stringify({ manifest: packManifest, policy: packPolicy, intents, chunks, faqs }));
  return { manifest: packManifest, policy: packPolicy, intents, chunks, faqs, contentHash };
}
