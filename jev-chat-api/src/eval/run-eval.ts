import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ChatEngine, ExtractiveAnswerer, JEV_MODEL, templateVersionLabel, type Judge, type Policy, type TemplateLang } from "../core";
import { JevLimiter } from "../adapters/jev/limiter";
import { SdkJevTransport } from "../adapters/jev/sdk-transport";
import { TypesafeJudge } from "../adapters/jev/typesafe-judge";
import { loadDomainPack, type DomainPack } from "../adapters/knowledge/pack-loader";
import type { EvalItem } from "./eval-item";
import { evalCodeTree, fileSha256, sha256, type Fingerprint } from "./fingerprint";
import { decideHoldout, HoldoutLedger, mergeRerun, parseScoresFile, serializeScores } from "./holdout-lock";
import { loadEvalSet } from "./load-set";
import { computeMetrics } from "./metrics";
import { buildOfflineSnapshot, ItemContextReader } from "./offline-snapshot";
import { applyPolicyOverride } from "./policy-override";
import { renderMarkdown } from "./report";
import { combineRuns, scoreItem, type ItemScore } from "./score";

type Order = "normal" | "reversed";

interface RunOpts {
  pack: DomainPack;
  items: EvalItem[];
  judgeFor: (order: Order) => Judge;
  templateLang: TemplateLang;
  optionOrder: Order;
  policy: Policy;
  concurrency?: number;
  limiterWaitMs: number;
  /** 재실행: 원 점수. option_order는 공급자 실패였던 방향만 다시 실행하고 나머지 방향은 원 실행 점수를 재사용한다 [H1] */
  reuse?: Map<string, ItemScore>;
}

async function runOne(o: RunOpts, item: EvalItem, judge: Judge) {
  const snapshot = buildOfflineSnapshot(o.pack, { templateLang: o.templateLang, limiterWaitMs: o.limiterWaitMs, policy: o.policy });
  const engine = new ChatEngine({ judge, answerer: new ExtractiveAnswerer(), contextReader: new ItemContextReader(item, o.pack) });
  try {
    return await engine.handle({
      principal: { userId: "eval", roles: ["user"] }, sessionId: "eval", turnId: item.id, turnSeq: item.turns.length / 2 + 1, text: item.message, snapshot,
      signal: AbortSignal.timeout(snapshot.policy.deadlines.engineMs),
    });
  } catch (e) {
    // 오류 이름만 남긴다(메시지에 비밀이 섞일 수 있음)
    return { thrown: true as const, errorName: e instanceof Error ? e.name : typeof e };
  }
}

export async function runEval(o: RunOpts): Promise<ItemScore[]> {
  const other: Order = o.optionOrder === "normal" ? "reversed" : "normal";
  const scores: ItemScore[] = new Array(o.items.length);
  let next = 0;
  const worker = async () => {
    while (next < o.items.length) {
      const i = next++;
      const item = o.items[i]!;
      if (item.type !== "option_order") {
        scores[i] = scoreItem(item, await runOne(o, item, o.judgeFor(o.optionOrder)));
        continue;
      }
      const prev = o.reuse?.get(item.id)?.runs;
      const orders: Order[] = [o.optionOrder, other];
      const runs = [] as unknown as [ItemScore, ItemScore];
      for (const k of [0, 1] as const) {
        const kept = prev?.[k];
        runs[k] = kept && kept.failure !== "provider" ? kept : scoreItem(item, await runOne(o, item, o.judgeFor(orders[k]!)));
      }
      scores[i] = combineRuns(runs[0], runs[1]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return scores;
}

// ── CLI ───────────────────────────────────────────────
const EvalEnv = z.object({
  TYPESAFE_API_KEY: z.string().min(1),
  TYPESAFE_BASE_URL: z.url().optional(),
  JEV_MAX_CONCURRENT: z.coerce.number().int().positive().default(40),
  JEV_MAX_RPS: z.coerce.number().int().positive().default(70),
  JEV_MAX_TPS: z.coerce.number().int().positive().default(80000),
  JEV_LIMITER_WAIT_MS: z.coerce.number().int().positive().default(3000),
  JEV_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      set: { type: "string" }, lang: { type: "string", default: "en" }, order: { type: "string", default: "normal" },
      policy: { type: "string" }, limit: { type: "string" }, rc: { type: "string" }, "rerun-provider-failures": { type: "boolean", default: false },
      pack: { type: "string", default: "domain-pack/hanbit-erp" },
    },
  });
  const set = z.enum(["tune", "holdout"]).parse(values.set);
  const lang = z.enum(["en", "ko"]).parse(values.lang);
  const order = z.enum(["normal", "reversed"]).parse(values.order);
  const env = EvalEnv.parse(process.env);
  const packDir = resolve(process.cwd(), values.pack!);
  const pack = await loadDomainPack(packDir);
  const setFile = join(packDir, "eval", `${set}.jsonl`);
  let items = await loadEvalSet(setFile, pack);

  const limiter = new JevLimiter({ maxConcurrent: env.JEV_MAX_CONCURRENT, maxRequestsPerSecond: env.JEV_MAX_RPS, maxTokensPerSecond: env.JEV_MAX_TPS, maxWaitMs: env.JEV_LIMITER_WAIT_MS });
  const transport = new SdkJevTransport({ apiKey: env.TYPESAFE_API_KEY, ...(env.TYPESAFE_BASE_URL ? { baseURL: env.TYPESAFE_BASE_URL } : {}) });
  const judgeFor = (o: Order) => new TypesafeJudge({ transport, limiter, attemptTimeoutMs: env.JEV_ATTEMPT_TIMEOUT_MS, lang, optionOrder: o });
  const startedAt = new Date().toISOString();
  const outDir = resolve(process.cwd(), "eval-reports");
  await mkdir(outDir, { recursive: true });
  const stem = join(outDir, `${startedAt.replace(/[:.]/g, "-")}-${set}-${lang}`);

  if (set === "tune") {
    if (values.limit !== undefined) {
      const n = z.coerce.number().int().positive().parse(values.limit);
      items = items.slice(0, n);
    }
    const override = values.policy ? applyPolicyOverride(pack.policy, parseYaml(await readFile(values.policy, "utf8"))) : { policy: pack.policy, overrideHash: null };
    const scores = await runEval({ pack, items, judgeFor, templateLang: lang, optionOrder: order, policy: override.policy, limiterWaitMs: env.JEV_LIMITER_WAIT_MS });
    const metrics = computeMetrics(scores);
    const meta = { set, templateLang: lang, optionOrder: order, packName: pack.manifest.name, packVersion: pack.manifest.version, contentHash: pack.contentHash, policyOverrideHash: override.overrideHash, startedAt };
    await writeFile(`${stem}.json`, JSON.stringify({ meta, policy: override.policy, metrics, scores }, null, 2));
    await writeFile(`${stem}.md`, renderMarkdown(meta, metrics, scores, { includeItems: true }));
    console.log(`tune(${lang}) ${scores.length}건 — ${metrics.overallPass ? "합격" : "불합격"} → ${stem}.md`);
    return metrics.overallPass ? 0 : 2;
  }

  // ── holdout ──
  if (values.limit !== undefined || values.policy || order !== "normal") throw new Error("holdout에는 --limit·--policy·--order reversed를 쓸 수 없습니다.");
  const rc = z.string().min(1).parse(values.rc);
  const freeze = JSON.parse(await readFile(join(packDir, "eval", "holdout.freeze.json"), "utf8")) as { sha256: string };
  const holdoutHash = await fileSha256(setFile);
  if (freeze.sha256 !== holdoutHash) throw new Error("holdout.jsonl이 freeze 기록과 다릅니다(검토 터미널이 freeze를 갱신해야 함).");
  const fp: Fingerprint = {
    packHash: pack.contentHash, holdoutHash, templateLang: lang, optionOrder: order, templateVersion: templateVersionLabel(lang),
    model: JEV_MODEL, policyHash: sha256(JSON.stringify(pack.policy)), codeTree: evalCodeTree(process.cwd()),
  };
  const ledger = new HoldoutLedger(join(packDir, "eval", "holdout-ledger"));
  const rerun = values["rerun-provider-failures"]!;
  const status = await ledger.status(rc);
  const recorded = (await ledger.result(rc)) ?? undefined;
  const decision = decideHoldout(status, rerun ? "rerun" : "first", rerun ? null : await ledger.findByFingerprint(fp), recorded, fp);
  if (!decision.allowed) throw new Error(decision.reason);
  const meta = { set, templateLang: lang, optionOrder: order, packName: pack.manifest.name, packVersion: pack.manifest.version, contentHash: pack.contentHash, policyOverrideHash: null, startedAt, releaseCandidate: rc, fingerprint: fp as unknown as Record<string, string> };

  let scores: ItemScore[];
  const scoresFile = join(outDir, `holdout-${rc}-scores${rerun ? "-merged" : ""}.json`);
  if (!rerun) {
    await ledger.reserve(rc, fp);
    scores = await runEval({ pack, items, judgeFor, templateLang: lang, optionOrder: order, policy: pack.policy, limiterWaitMs: env.JEV_LIMITER_WAIT_MS });
  } else {
    const originalRaw = await readFile(recorded!.scoresFile, "utf8");
    if (sha256(originalRaw) !== recorded!.scoresSha256) throw new Error("원 실행 점수 파일이 기록과 다릅니다.");
    const original = parseScoresFile(originalRaw);
    await ledger.reserveRerun(rc, fp);
    const retry = items.filter((i) => recorded!.providerFailedIds.includes(i.id));
    const rescored = await runEval({ pack, items: retry, reuse: new Map(original.map((x) => [x.id, x])), judgeFor, templateLang: lang, optionOrder: order, policy: pack.policy, limiterWaitMs: env.JEV_LIMITER_WAIT_MS });
    scores = mergeRerun(original, rescored, recorded!.providerFailedIds);
  }
  const metrics = computeMetrics(scores, { requireCoverage: true });
  const raw = serializeScores(scores);
  await writeFile(scoresFile, raw);
  const result = {
    rc, fingerprint: fp, overallPass: metrics.overallPass, rates: metrics.rates,
    providerFailedIds: scores.filter((s) => s.failure === "provider").map((s) => s.id), scoresFile, scoresSha256: sha256(raw), finishedAt: new Date().toISOString(),
  };
  if (rerun) await ledger.completeRerun(rc, result);
  else await ledger.complete(rc, result);
  await writeFile(`${stem}.md`, renderMarkdown(meta, metrics, scores, { includeItems: false }));
  console.log(`holdout RC ${rc}${rerun ? " (재실행 병합)" : ""} — ${metrics.overallPass ? "합격" : "불합격"} → ${stem}.md`);
  return metrics.overallPass ? 0 : 2;
}
