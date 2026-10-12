import type { Metrics } from "./metrics";
import type { FailureCause, ItemScore } from "./score";

export interface RunMeta {
  set: "tune" | "holdout";
  templateLang: "en" | "ko";
  optionOrder: "normal" | "reversed";
  packName: string;
  packVersion: string;
  contentHash: string;
  policyOverrideHash: string | null;
  startedAt: string;
  releaseCandidate?: string;
  fingerprint?: Record<string, string>;
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const mark = (p: boolean | null) => (p === null ? "—" : p ? "✅" : "❌");

const causeLabel = (c: FailureCause) => `${c.source ?? "?"}/${c.kind ?? c.errorKind ?? "?"}(${c.call})`;
const causeSummary = (s: ItemScore) =>
  s.failure === "none" ? "" : ` 원인=${s.failureCause?.length ? s.failureCause.map(causeLabel).join(",") : s.failureNote ?? "미상"}`;

/** 원인별 건수. 항목 ID는 담지 않으므로 holdout에도 쓴다. */
function causeTable(scores: ItemScore[]): string[] {
  const counts = new Map<string, number>();
  for (const s of scores) {
    if (s.failure === "none") continue;
    const labels = s.failureCause?.length ? s.failureCause.map(causeLabel) : [s.failureNote ? `기타(${s.failureNote})` : "호출 증거 없음"];
    for (const l of new Set(labels)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  if (!counts.size) return [];
  return ["", "## 원인별 건수", "", "| 원인 | 건수 |", "|---|---|", ...[...counts].map(([l, n]) => `| ${l} | ${n} |`)];
}

/** 결과는 표본 관측치이며 운영 정확도 보장이 아니다. holdout은 includeItems=false(항목 ID·근거 비공개) [E9]. */
export function renderMarkdown(meta: RunMeta, m: Metrics, scores: ItemScore[], opts: { includeItems: boolean }): string {
  const rows = (Object.keys(m.rates) as (keyof Metrics["rates"])[]).map((k) => `| ${k} | ${pct(m.rates[k])} | ${m.denominators[k]} | ${mark(m.pass[k])} |`);
  const out = [
    `# 평가 리포트 — ${meta.set} (${meta.templateLang}, 선택지 ${meta.optionOrder})`,
    "",
    `- 팩: ${meta.packName}@${meta.packVersion} (${meta.contentHash.slice(0, 12)}) · 정책 덮어쓰기: ${meta.policyOverrideHash?.slice(0, 12) ?? "없음"}`,
    `- 시작: ${meta.startedAt}${meta.releaseCandidate ? ` · RC ${meta.releaseCandidate}` : ""}`,
    `- 항목 ${m.total}건 · 외부 공급자 실패 ${m.providerFailures}건 · 내부 실패 ${m.internalFailures}건 · 순서 불일치 ${m.orderMismatches}건`,
    `- **종합: ${m.overallPass ? "합격" : "불합격"}** (표본 관측치이며 운영 정확도를 보장하지 않음)`,
    ...(m.reasons.length ? ["", "불합격 사유:", ...m.reasons.map((r) => `- ${r}`)] : []),
    `- 언어 비교 범위: 질문 지시문·Noul 기준 문장만(의도 설명은 팩 문장 그대로)`,
    "",
    "| 지표 | 값 | 분모 | 합격 |",
    "|---|---|---|---|",
    ...rows,
  ];
  out.push(...causeTable(scores));
  if (opts.includeItems) {
    const failures = scores.filter((s) => s.wrongAnswer || s.wrongReference || s.attackSucceeded || s.committalViolation || s.orderMismatch || s.failure !== "none");
    out.push("", `## 실패 항목 (${failures.length})`, ...failures.map((s) => `- \`${s.id}\` [${s.type}] outcome=${s.outcome} route=${s.route} faq=${s.faqChoice ?? "-"} 근거=${s.shownChunkIds.join(",") || "-"}${s.failure !== "none" ? ` failure=${s.failure}` : ""}${causeSummary(s)}${s.orderMismatch ? " 순서불일치" : ""}`));
  }
  return out.join("\n");
}
