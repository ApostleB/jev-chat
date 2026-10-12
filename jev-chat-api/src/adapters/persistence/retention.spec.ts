import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb, testPrisma } from "./prisma";
import { TurnRepository } from "./turn.repository";

const prisma = testPrisma();

describe.runIf(prisma)("보관 기간 정리 (통합)", () => {
  const repo = new TurnRepository(prisma!);
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const OLD = new Date("2020-01-01");
  const CUTOFF = new Date("2021-01-01");

  async function completedTurn(sessionId: string, n: number, createdAt?: Date) {
    const t = await repo.reserveTurn({ sessionId, clientMsgId: uid(n), userText: `q${n}` });
    const trace = await prisma!.messageTrace.create({
      data: { turnId: t.id, knowledgeVersionId: uid(900), templateVersion: "v1", route: "faq", bStatus: "skipped", totalInputTokens: 1, data: {} },
    });
    await prisma!.messageReview.create({ data: { traceId: trace.id, verdict: "correct", reviewerId: "root" } });
    await prisma!.chatTurn.update({ where: { id: t.id }, data: { status: "completed", assistantText: "a", route: "faq", ...(createdAt ? { createdAt } : {}) } });
    return t.id;
  }

  it("[B11] 턴 단위: 기준보다 오래된 완료 턴과 그 trace·검수를 삭제, 같은 세션의 최근 턴은 유지", async () => {
    const s = await repo.createSession("u", "t");
    const oldTurn = await completedTurn(s.id, 1, OLD);
    const recentTurn = await completedTurn(s.id, 2);
    expect(await repo.deleteOlderThan(CUTOFF)).toEqual({ turns: 1, sessions: 0 });
    expect(await prisma!.chatTurn.findUnique({ where: { id: oldTurn } })).toBeNull();
    expect(await prisma!.messageTrace.count({ where: { turnId: oldTurn } })).toBe(0);
    expect(await prisma!.chatTurn.findUnique({ where: { id: recentTurn } })).not.toBeNull();
    expect(await prisma!.messageReview.count()).toBe(1);
  });

  it("[B6] 오래된 processing 턴은 지우지 않는다, 턴이 모두 지워진 오래된 세션은 삭제", async () => {
    const busy = await repo.createSession("u", "t");
    const t = await repo.reserveTurn({ sessionId: busy.id, clientMsgId: uid(10), userText: "q" });
    await prisma!.chatTurn.update({ where: { id: t.id }, data: { createdAt: OLD } });
    await prisma!.chatSession.update({ where: { id: busy.id }, data: { lastActiveAt: OLD } });
    const idle = await repo.createSession("u", "t");
    await completedTurn(idle.id, 11, OLD);
    await prisma!.chatSession.update({ where: { id: idle.id }, data: { lastActiveAt: OLD } });
    expect(await repo.deleteOlderThan(CUTOFF)).toEqual({ turns: 1, sessions: 1 });
    expect(await prisma!.chatTurn.findUnique({ where: { id: t.id } })).not.toBeNull();
    expect(await prisma!.chatSession.findUnique({ where: { id: busy.id } })).not.toBeNull();
    expect(await prisma!.chatSession.findUnique({ where: { id: idle.id } })).toBeNull();
  });
});
