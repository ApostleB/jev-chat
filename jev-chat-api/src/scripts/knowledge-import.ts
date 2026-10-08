import "dotenv/config";
import { resolve } from "node:path";
import { loadDomainPack, PackValidationError } from "../adapters/knowledge/pack-loader";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { validateEnv } from "../app/config/env.schema";

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const dir = resolve(process.cwd(), process.argv[2] ?? env.DOMAIN_PACK_DIR);
  const prisma = createPrismaClient({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: 2,
  });
  try {
    const pack = await loadDomainPack(dir);
    const result = await new KnowledgeRepository(prisma).importPack(pack);
    console.log(
      result.skipped
        ? `변경 없음: 활성 버전 ${result.versionId}와 내용이 같습니다.`
        : `적재 완료: 버전 ${result.versionId} (청크 ${pack.chunks.length}, FAQ ${pack.faqs.length}). 실행 중인 서버는 POST /api/admin/knowledge/reload로 반영하세요.`,
    );
  } catch (e) {
    if (e instanceof PackValidationError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
