import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, dbConfigFromUrl, resetTestDb, testPrisma } from "./prisma";

describe("dbConfigFromUrl", () => {
  it("URL을 어댑터 옵션으로 바꾼다(인코딩된 비밀번호 포함)", () => {
    expect(dbConfigFromUrl("mysql://jev:p%40ss@db.local:3307/jev_chat_test")).toEqual({
      host: "db.local", port: 3307, user: "jev", password: "p@ss", database: "jev_chat_test", connectionLimit: 5,
    });
  });
});

const prisma = testPrisma();

describe.runIf(prisma)("Prisma 스키마 (통합)", () => {
  beforeEach(async () => resetTestDb(prisma!));
  afterAll(async () => prisma?.$disconnect());

  it("세션 안에서 turn_seq와 client_msg_id는 유일하다", async () => {
    await prisma!.chatSession.create({ data: { id: "00000000-0000-4000-8000-000000000001", userId: "u", channel: "test" } });
    const base = { sessionId: "00000000-0000-4000-8000-000000000001", userText: "q", status: "processing" as const };
    await prisma!.chatTurn.create({ data: { ...base, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a1" } });
    await expect(prisma!.chatTurn.create({ data: { ...base, turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000a2" } })).rejects.toThrow();
    await expect(prisma!.chatTurn.create({ data: { ...base, turnSeq: 2, clientMsgId: "00000000-0000-4000-8000-0000000000a1" } })).rejects.toThrow();
  });

  it("[저장 기한·D2] 풀의 서로 다른 연결 N개를 동시에 점유해도 모두 행 잠금 대기 제한이 2초다", async () => {
    // 대화형 트랜잭션 N개가 각자 연결을 쥔 채 barrier에서 기다리게 해, 서로 다른 물리 연결 N개에 initSql이 적용됐는지 본다
    const N = 4;
    const client = createPrismaClient({ ...dbConfigFromUrl(process.env.TEST_DATABASE_URL!), connectionLimit: N });
    try {
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const seen = await Promise.all(
        Array.from({ length: N }, () =>
          client.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ id: number | bigint; t: number | bigint; tz: string }[]>`SELECT CONNECTION_ID() AS id, @@SESSION.innodb_lock_wait_timeout AS t, @@SESSION.time_zone AS tz`;
            if (++arrived === N) release();
            await barrier; // 모든 트랜잭션이 조회를 마칠 때까지 연결을 점유한다
            return { id: Number(rows[0]?.id), t: Number(rows[0]?.t), tz: String(rows[0]?.tz) };
          }, { maxWait: 10_000, timeout: 15_000 }),
        ),
      );
      expect(new Set(seen.map((s) => s.id)).size, JSON.stringify(seen)).toBe(N);
      for (const s of seen) expect(s.t, JSON.stringify(s)).toBe(2);
      // [M-5] NOW(3)·DATETIME 해석이 서버 설정에 흔들리지 않도록 모든 연결의 세션 시간대는 UTC
      for (const s of seen) expect(s.tz, JSON.stringify(s)).toBe("+00:00");
    } finally {
      await client.$disconnect();
    }
  }, 20_000);

  it("한국어와 이모지를 그대로 저장한다(utf8mb4)", async () => {
    await prisma!.chatSession.create({ data: { id: "00000000-0000-4000-8000-000000000002", userId: "u", channel: "test" } });
    const t = await prisma!.chatTurn.create({
      data: { sessionId: "00000000-0000-4000-8000-000000000002", turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000b1", userText: "연차 이월 되나요? 😀", status: "processing" },
    });
    expect((await prisma!.chatTurn.findUnique({ where: { id: t.id } }))?.userText).toBe("연차 이월 되나요? 😀");
  });
});
