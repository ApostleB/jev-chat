import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { validateEnv } from "../app/config/env.schema";

type Outcome = "ANSWER" | "REFERENCE" | "HOLD" | "BLOCK" | "ERROR";
type SourceLike = { chunkId: string };

function routeToOutcome(route: string): Outcome {
  if (route === "faq" || route === "extractive") return "ANSWER";
  if (route === "reference") return "REFERENCE";
  if (route === "blocked") return "BLOCK";
  if (route === "error") return "ERROR";
  return "HOLD";
}

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
      const turns = ctxRows.flatMap((t) => [
        { role: "user", text: t.userText },
        { role: "assistant", text: t.assistantText ?? "", sources: ((t.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId) },
      ]);
      const shown = ((turn.sources as SourceLike[] | null) ?? []).map((s) => s.chunkId);
      const outcome = routeToOutcome(r.trace.route);
      const expectedChunks = Array.isArray(r.expectedChunkIds) && r.expectedChunkIds.length > 0 ? (r.expectedChunkIds as string[]) : null;
      // 보관 기간 정리 등으로 참조 턴 일부가 사라졌으면 문맥이 불완전하다 → 자동 라벨 금지
      const contextComplete = ctxRows.length === (data.contextTurnSeqs?.length ?? 0);

      let expect: Record<string, unknown> | null = null;
      if (!contextComplete) {
        expect = null;
      } else if (r.verdict === "correct") {
        expect = {
          intent: r.expectedIntent ?? r.trace.intent,
          allowed_outcomes: [outcome],
          ...(r.trace.route === "faq" && r.trace.faqChoice ? { faq_ids: [r.trace.faqChoice] } : {}),
          ...((outcome === "ANSWER" || outcome === "REFERENCE") && shown.length > 0 ? { acceptable_chunk_ids: shown, required_chunk_ids_any: shown } : {}),
          attack_goal: null,
        };
      } else if (r.expectedFaqId || expectedChunks) {
        expect = {
          intent: r.expectedIntent ?? r.trace.intent,
          allowed_outcomes: ["ANSWER"],
          ...(r.expectedFaqId ? { faq_ids: [r.expectedFaqId] } : {}),
          ...(expectedChunks ? { acceptable_chunk_ids: expectedChunks, required_chunk_ids_any: expectedChunks } : {}),
          attack_goal: null,
        };
      }
      const item = {
        id: `review-${r.id}`,
        type: turns.length > 0 ? "followup" : "from_review",
        knowledge_version_id: r.trace.knowledgeVersionId,
        turns,
        message: turn.userText,
        ...(expect ? { expect } : { review: { verdict: r.verdict, note: r.note, route: r.trace.route, contextComplete } }),
      };
      (expect ? ready : pending).push(JSON.stringify(item));
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
