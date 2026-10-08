import { resolve } from "node:path";
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
    const broken = { ...pack, contentHash: "e".repeat(64), faqs: pack.faqs.map((f) => ({ ...f, variants: ["가".repeat(1001)] })) };
    await expect(repo.importPack(broken)).rejects.toThrow();
    expect((await repo.loadActive())?.versionId).toBe(v1.versionId);
    expect(await prisma!.knowledgeVersion.count()).toBe(1);
  });
});
