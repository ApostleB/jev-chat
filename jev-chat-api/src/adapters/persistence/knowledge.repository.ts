import type { Chunk, Faq, IntentId } from "../../core";
import type { PrismaClient } from "../../generated/prisma/client";
import type { DomainPack } from "../knowledge/pack-loader";

export interface ActiveKnowledge {
  versionId: string;
  pack: Omit<DomainPack, "chunks" | "faqs" | "contentHash">;
  chunks: Chunk[];
  faqs: Faq[];
}

type PackSnapshot = Omit<DomainPack, "chunks" | "faqs" | "contentHash">;

export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * [P7] 원자 import: knowledge_state(id=1) 행을 FOR UPDATE로 잠가 동시 import를 직렬화하고,
   * 잠금 안에서 활성 버전의 contentHash를 다시 비교한다. 실패하면 전체 롤백(실패 버전 행을 남기지 않음).
   */
  async importPack(pack: DomainPack): Promise<{ versionId: string; skipped: boolean }> {
    const snapshot: PackSnapshot = { manifest: pack.manifest, policy: pack.policy, intents: pack.intents };
    return this.prisma.$transaction(
      async (tx) => {
        // INSERT IGNORE는 중복 시 공유(S) 락만 잡아 FOR UPDATE와 교착(1213)하므로, 중복이어도 배타(X) 락을 잡는 ON DUPLICATE KEY UPDATE를 쓴다.
        await tx.$executeRaw`INSERT INTO knowledge_state (id, active_version_id) VALUES (1, NULL) ON DUPLICATE KEY UPDATE id = id`;
        const rows = await tx.$queryRaw<{ active_version_id: string | null }[]>`SELECT active_version_id FROM knowledge_state WHERE id = 1 FOR UPDATE`;
        const activeId = rows[0]?.active_version_id ?? null;
        if (activeId) {
          const active = await tx.knowledgeVersion.findUnique({ where: { id: activeId }, select: { contentHash: true } });
          if (active?.contentHash === pack.contentHash) return { versionId: activeId, skipped: true };
        }
        const v = await tx.knowledgeVersion.create({
          data: {
            packName: pack.manifest.name,
            packVersion: pack.manifest.version,
            contentHash: pack.contentHash,
            status: "active",
            packSnapshot: snapshot as object,
          },
        });
        await tx.knowledgeChunk.createMany({
          data: pack.chunks.map((c) => ({
            versionId: v.id,
            id: c.id,
            module: c.module,
            kind: c.kind,
            title: c.title,
            section: c.section,
            text: c.text,
            tags: c.tags,
            updatedAt: c.updatedAt,
            contentHash: c.contentHash,
          })),
        });
        await tx.faq.createMany({
          data: pack.faqs.map((f) => ({
            versionId: v.id,
            id: f.id,
            intent: f.intent,
            summary: f.summary,
            appliesWhen: f.appliesWhen,
            answer: f.answer,
            sourceChunkId: f.sourceChunkId,
          })),
        });
        await tx.faqVariant.createMany({
          data: pack.faqs.flatMap((f) => f.variants.map((text) => ({ versionId: v.id, faqId: f.id, text }))),
        });
        if (activeId) await tx.knowledgeVersion.update({ where: { id: activeId }, data: { status: "archived" } });
        await tx.knowledgeState.update({ where: { id: 1 }, data: { activeVersionId: v.id } });
        return { versionId: v.id, skipped: false };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  }

  async loadActive(): Promise<ActiveKnowledge | null> {
    const state = await this.prisma.knowledgeState.findUnique({ where: { id: 1 } });
    if (!state?.activeVersionId) return null;
    const v = await this.prisma.knowledgeVersion.findUnique({ where: { id: state.activeVersionId } });
    if (!v) return null;
    const [chunkRows, faqRows] = await Promise.all([
      this.prisma.knowledgeChunk.findMany({ where: { versionId: v.id }, orderBy: { id: "asc" } }),
      this.prisma.faq.findMany({ where: { versionId: v.id }, include: { variants: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } }),
    ]);
    return {
      versionId: v.id,
      pack: v.packSnapshot as unknown as PackSnapshot,
      chunks: chunkRows.map((c) => ({
        id: c.id,
        module: c.module,
        kind: c.kind,
        title: c.title,
        section: c.section,
        text: c.text,
        tags: c.tags as string[],
        updatedAt: c.updatedAt,
        contentHash: c.contentHash,
      })),
      faqs: faqRows.map((f) => ({
        id: f.id,
        intent: f.intent as IntentId,
        summary: f.summary,
        appliesWhen: f.appliesWhen,
        answer: f.answer,
        sourceChunkId: f.sourceChunkId,
        variants: f.variants.map((v) => v.text),
      })),
    };
  }
}
