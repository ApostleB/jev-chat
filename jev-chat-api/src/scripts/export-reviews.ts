import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { validateEnv } from "../app/config/env.schema";
import { buildExportItem } from "./export-reviews.lib";

/**
 * [B10] 검수 결과를 설계 6장 평가 항목 형식으로 내보낸다(tune 후보 전용).
 * - 원래 대화 문맥(trace.contextTurnSeqs)과 실제 출처를 복원한다.
 * - 라벨을 결정할 수 없는 항목(wrong/partial인데 정답 FAQ·청크가 없음)은 needs-labeling 파일로 분리한다.
 */
async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const out = process.argv[2] ?? "eval-from-reviews.jsonl";
  const needsLabeling = out.replace(/\.jsonl$/, "") + ".needs-labeling.jsonl";
  const prisma = createPrismaClient({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, connectionLimit: 2 });
  try {
    const reviews = await prisma.messageReview.findMany({ include: { trace: { include: { turn: true } } }, orderBy: { createdAt: "asc" } });
    const ready: string[] = [];
    const pending: string[] = [];
    for (const r of reviews) {
      const turn = r.trace.turn;
      const data = r.trace.data as { contextTurnSeqs?: number[] };
      const ctxRows = data.contextTurnSeqs?.length
        ? await prisma.chatTurn.findMany({ where: { sessionId: turn.sessionId, turnSeq: { in: data.contextTurnSeqs } }, orderBy: { turnSeq: "asc" } })
        : [];
      const { ready: isReady, item } = buildExportItem(r, ctxRows);
      (isReady ? ready : pending).push(JSON.stringify(item));
    }
    writeFileSync(out, ready.join("\n") + (ready.length ? "\n" : ""));
    writeFileSync(needsLabeling, pending.join("\n") + (pending.length ? "\n" : ""));
    console.log(`검수 ${reviews.length}건 → 평가 후보 ${ready.length}건(${out}), 라벨 필요 ${pending.length}건(${needsLabeling})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  // 오류 이름만 기록한다(DB 오류 메시지에 질문 원문·접속 정보가 섞일 수 있다)
  console.error(`검수 내보내기 실패: ${e instanceof Error ? e.name : "알 수 없는 오류"}`);
  process.exitCode = 1;
});
