import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bm25Retriever } from "../../core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadDomainPack } from "../knowledge/pack-loader";
import { KnowledgeRepository } from "./knowledge.repository";
import { resetTestDb, testPrisma } from "./prisma";

const prisma = testPrisma();
const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");

describe.runIf(prisma)("KnowledgeRepository (통합)", () => {
  const repo = new KnowledgeRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("팩을 새 버전으로 적재하고 active로 만든다", async () => {
    const pack = await loadDomainPack(MINI);
    const { versionId, skipped } = await repo.importPack(pack);
    expect(skipped).toBe(false);
    const active = await repo.loadActive();
    expect(active?.versionId).toBe(versionId);
    expect(active?.chunks.map((c) => c.id).sort()).toEqual(["card-001", "card-002"]);
    expect(active?.faqs[0]).toMatchObject({ id: "faq-card-limit", variants: ["법인카드 한도 얼마예요?", "카드 한 번에 얼마까지 써요"] });
    expect(active?.pack.policy.faq).toBe(0.8);
    expect(active?.pack.manifest.helpdesk.email).toBe("help@hanbit.example");
  });

  it("같은 내용을 다시 import하면 건너뛴다", async () => {
    const pack = await loadDomainPack(MINI);
    const first = await repo.importPack(pack);
    const second = await repo.importPack(pack);
    expect(second).toEqual({ versionId: first.versionId, skipped: true });
  });

  it("새 버전을 적재하면 이전 active는 archived가 되고 데이터는 보존된다", async () => {
    const pack = await loadDomainPack(MINI);
    const v1 = await repo.importPack(pack);
    const v2 = await repo.importPack({ ...pack, contentHash: "f".repeat(64) });
    expect((await repo.loadActive())?.versionId).toBe(v2.versionId);
    const old = await prisma!.knowledgeVersion.findUnique({ where: { id: v1.versionId } });
    expect(old?.status).toBe("archived");
    expect((await prisma!.knowledgeState.findUnique({ where: { id: 1 } }))?.activeVersionId).toBe(v2.versionId);
    expect(await prisma!.knowledgeChunk.count({ where: { versionId: v1.versionId } })).toBe(2);
  });

  it("[R2] 파일→DB 왕복 후에도 chunks/faqs 순서와 동점 검색 결과가 같다", async () => {
    // 정렬이 갈릴 만한 id(하이픈·숫자·문자 혼합). 줄 순서는 일부러 뒤섞고, 내용은 모두 같아 BM25 동점이다.
    const ids = ["b-2", "a1", "ab", "a-1", "a0"];
    const dir = mkdtempSync(join(tmpdir(), "tie-pack-"));
    cpSync(MINI, dir, { recursive: true });
    const chunk = (id: string) => JSON.stringify({ id, module: "경비", kind: "regulation", title: "동점 규정", section: "제1조", text: "동점 검색 본문 한도", tags: [], updated_at: "2026-01-02" });
    const faq = (id: string) => JSON.stringify({ id: `f-${id}`, intent: "regulation", summary: "동점 검색 요약 한도", applies_when: "항상", answer: "답", source_chunk_id: id, variants: ["동점 검색 한도"] });
    writeFileSync(join(dir, "chunks.jsonl"), ids.map(chunk).join("\n") + "\n");
    writeFileSync(join(dir, "faqs.jsonl"), ids.map(faq).join("\n") + "\n");
    const pack = await loadDomainPack(dir);
    await repo.importPack(pack);
    const active = await repo.loadActive();
    expect(active?.chunks.map((c) => c.id)).toEqual(pack.chunks.map((c) => c.id));
    expect(active?.faqs.map((f) => f.id)).toEqual(pack.faqs.map((f) => f.id));
    const fileR = new Bm25Retriever(pack.faqs, pack.chunks);
    const dbR = new Bm25Retriever(active!.faqs, active!.chunks);
    expect(dbR.searchChunks(["동점 검색 한도"], 1).map((c) => c.chunk.id)).toEqual(fileR.searchChunks(["동점 검색 한도"], 1).map((c) => c.chunk.id));
    expect(dbR.searchFaqs("동점 검색 한도", 1).map((c) => c.faq.id)).toEqual(fileR.searchFaqs("동점 검색 한도", 1).map((c) => c.faq.id));
  });

  it("active가 없으면 null", async () => {
    expect(await repo.loadActive()).toBeNull();
  });

  it("[P7] 같은 팩을 동시에 import하면 한 번만 적재된다", async () => {
    const pack = await loadDomainPack(MINI);
    const results = await Promise.all([repo.importPack(pack), repo.importPack(pack), repo.importPack(pack)]);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    expect(await prisma!.knowledgeVersion.count()).toBe(1);
  });

  it("[P7] 적재 중 실패하면 전체 롤백 — 기존 active와 버전 수 유지, failed 행 없음", async () => {
    const pack = await loadDomainPack(MINI);
    const v1 = await repo.importPack(pack);
    // 로더를 우회해 DB 제약(VARCHAR(1000))을 넘는 변형 문장을 넣는다
    const mode = await prisma!.$queryRaw<{ m: string }[]>`SELECT @@SESSION.sql_mode AS m`;
    expect(mode[0]?.m, "테스트 DB의 sql_mode는 STRICT_TRANS_TABLES 또는 STRICT_ALL_TABLES여야 한다").toMatch(/STRICT_(TRANS|ALL)_TABLES/);
    const broken = { ...pack, contentHash: "e".repeat(64), faqs: pack.faqs.map((f) => ({ ...f, variants: ["가".repeat(1001)] })) };
    await expect(repo.importPack(broken)).rejects.toThrow();
    expect((await repo.loadActive())?.versionId).toBe(v1.versionId);
    expect(await prisma!.knowledgeVersion.count()).toBe(1);
  });
});
