import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dbConfigFromUrl, resetTestDb, testPrisma } from "./prisma";

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

  it("한국어와 이모지를 그대로 저장한다(utf8mb4)", async () => {
    await prisma!.chatSession.create({ data: { id: "00000000-0000-4000-8000-000000000002", userId: "u", channel: "test" } });
    const t = await prisma!.chatTurn.create({
      data: { sessionId: "00000000-0000-4000-8000-000000000002", turnSeq: 1, clientMsgId: "00000000-0000-4000-8000-0000000000b1", userText: "연차 이월 되나요? 😀", status: "processing" },
    });
    expect((await prisma!.chatTurn.findUnique({ where: { id: t.id } }))?.userText).toBe("연차 이월 되나요? 😀");
  });
});
