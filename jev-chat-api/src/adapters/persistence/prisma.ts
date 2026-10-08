import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
}

export function createPrismaClient(db: DbConfig): PrismaClient {
  const adapter = new PrismaMariaDb({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    connectTimeout: 5000,
  });
  return new PrismaClient({ adapter });
}

export function dbConfigFromUrl(url: string, connectionLimit = 5): DbConfig {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectionLimit,
  };
}

/** 통합 테스트용. TEST_DATABASE_URL이 없으면 null(테스트 skip). */
export function testPrisma(): PrismaClient | null {
  const url = process.env.TEST_DATABASE_URL;
  return url ? createPrismaClient(dbConfigFromUrl(url)) : null;
}

/** FK 순서대로 모든 테이블을 비운다. 테스트 DB에서만 사용. */
export async function resetTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.messageReview.deleteMany();
  await prisma.messageTrace.deleteMany();
  await prisma.chatTurn.deleteMany();
  await prisma.chatSession.deleteMany();
  await prisma.faqVariant.deleteMany();
  await prisma.faq.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeVersion.deleteMany();
  await prisma.knowledgeState.deleteMany();
}
