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

/**
 * 모든 DB 연결의 행 잠금 대기 상한(초). 저장 기한(saveMs)의 실제 상한을 만든다.
 * Prisma 트랜잭션 timeout은 진행 중인 쿼리를 취소하지 않으므로, DB 쪽에서 행 잠금 대기 자체를 끊는다.
 * (env 설정으로 노출하지 않는다.)
 */
export const DB_LOCK_WAIT_TIMEOUT_SECONDS = 2;

export function createPrismaClient(db: DbConfig): PrismaClient {
  const adapter = new PrismaMariaDb({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    connectTimeout: 5000,
    initSql: `SET SESSION innodb_lock_wait_timeout=${DB_LOCK_WAIT_TIMEOUT_SECONDS}`,
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
