import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack, PackValidationError } from "./pack-loader";

const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

function copyMini(): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync(MINI, dir, { recursive: true });
  return dir;
}

describe("loadDomainPack", () => {
  it("미니 팩을 도메인 타입으로 읽는다", async () => {
    const pack = await loadDomainPack(MINI);
    expect(pack.manifest).toMatchObject({ name: "mini-test", version: "0.0.1", templateVersion: "v1", helpdesk: { phone: "02-000-0000" } });
    expect(pack.policy.inScope).toEqual({ block: 0.4, clarify: 0.6 });
    expect(pack.policy.context).toEqual({ maxTurns: 2, assistantMaxChars: 300 });
    expect(pack.intents.map((i) => i.id)).toEqual(["regulation", "how_to", "error", "account_access", "smalltalk", "out_of_scope"]);
    expect(pack.chunks).toHaveLength(2);
    expect(pack.chunks[0]).toMatchObject({ id: "card-001", kind: "regulation", updatedAt: "2026-01-02" });
    expect(pack.chunks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.faqs[0]).toMatchObject({ id: "faq-card-limit", sourceChunkId: "card-001", appliesWhen: expect.any(String) });
    expect(pack.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("내용이 같으면 contentHash가 같고, 바뀌면 달라진다", async () => {
    const a = await loadDomainPack(MINI);
    const dir = copyMini();
    expect((await loadDomainPack(dir)).contentHash).toBe(a.contentHash);
    const p = join(dir, "chunks.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace("50만 원이다", "60만 원이다"));
    expect((await loadDomainPack(dir)).contentHash).not.toBe(a.contentHash);
  });

  it("FAQ source_chunk_id가 없는 청크를 가리키면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"card-001"', '"card-999"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/card-999/);
  });

  it("청크 ID 중복을 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "chunks.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"card-002"', '"card-001"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/중복/);
  });

  it("intents가 정확히 6개 의도가 아니면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "intents.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("id: smalltalk", "id: weather"));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("template_version이 코드와 다르면 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "manifest.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("template_version: v1", "template_version: v9"));
    await expect(loadDomainPack(dir)).rejects.toThrow(/template_version/);
  });

  it("[P8] FAQ id 'none'은 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"faq-card-limit"', '"none"'));
    await expect(loadDomainPack(dir)).rejects.toThrow(/none/);
  });

  it("[P8] 빈 source_chunk_id는 거부", async () => {
    const dir = copyMini();
    const p = join(dir, "faqs.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"source_chunk_id":"card-001"', '"source_chunk_id":""'));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("[P8] 문맥 상한(max_turns ≤ 3)과 DB 길이(module ≤ 100) 검증", async () => {
    const dir = copyMini();
    const pp = join(dir, "policy.yaml");
    writeFileSync(pp, readFileSync(pp, "utf8").replace("max_turns: 2", "max_turns: 9"));
    await expect(loadDomainPack(dir)).rejects.toThrow(/max_turns/);
    const dir2 = copyMini();
    const cp = join(dir2, "chunks.jsonl");
    writeFileSync(cp, readFileSync(cp, "utf8").replace('"module":"경비·법인카드"', `"module":"${"가".repeat(101)}"`));
    await expect(loadDomainPack(dir2)).rejects.toThrow(/module/);
  });

  it("[P10] policy에 limiter_ms가 있으면 거부(서버 설정 항목)", async () => {
    const dir = copyMini();
    const pp = join(dir, "policy.yaml");
    writeFileSync(pp, readFileSync(pp, "utf8").replace("save_ms: 3000", "save_ms: 3000, limiter_ms: 3000"));
    await expect(loadDomainPack(dir)).rejects.toBeInstanceOf(PackValidationError);
  });

  it("jsonl 형식 오류는 파일명과 줄 번호를 알려준다", async () => {
    const dir = copyMini();
    writeFileSync(join(dir, "chunks.jsonl"), '{"id":"x"}\n{broken\n');
    await expect(loadDomainPack(dir)).rejects.toThrow(/chunks\.jsonl:1|chunks\.jsonl:2/);
  });
});
