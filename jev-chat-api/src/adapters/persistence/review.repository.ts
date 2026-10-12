import type { Review, ReviewRequest } from "@jev-chat/protocol";
import type { PrismaClient } from "../../generated/prisma/client";

export class ReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(traceId: string, reviewerId: string, req: ReviewRequest): Promise<Review> {
    const r = await this.prisma.messageReview.create({
      data: {
        traceId, reviewerId, verdict: req.verdict, expectedIntent: req.expectedIntent ?? null, expectedFaqId: req.expectedFaqId ?? null,
        expectedChunkIds: req.expectedChunkIds ?? undefined, note: req.note ?? null,
      },
    });
    return this.toDto(r);
  }

  async listByTrace(traceId: string): Promise<Review[]> {
    const rows = await this.prisma.messageReview.findMany({ where: { traceId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => this.toDto(r));
  }

  private toDto(r: { id: string; verdict: "correct" | "wrong" | "partial"; expectedIntent: string | null; expectedFaqId: string | null; expectedChunkIds: unknown; note: string | null; reviewerId: string; createdAt: Date }): Review {
    return {
      id: r.id, verdict: r.verdict, reviewerId: r.reviewerId, createdAt: r.createdAt.toISOString(),
      ...(r.expectedIntent ? { expectedIntent: r.expectedIntent } : {}),
      ...(r.expectedFaqId ? { expectedFaqId: r.expectedFaqId } : {}),
      ...(Array.isArray(r.expectedChunkIds) ? { expectedChunkIds: r.expectedChunkIds as string[] } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  }
}
