import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack } from "../adapters/knowledge/pack-loader";
import { loadEvalSet } from "./load-set";

const PACK = resolve(process.cwd(), "domain-pack/hanbit-erp");
const MODULES = ["전자결재", "경비·법인카드", "회계·전표", "구매", "인사·근태", "계정·권한"];
const MIN_TYPES: Record<string, number> = {
  normal: 20, negation: 6, confusable: 12, out_of_scope: 8, smalltalk: 4, followup: 10, ambiguous: 6, injection: 6, number_date: 5, option_order: 4,
};

const norm = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const userTexts = (i: { message: string; turns: { role: string; text: string }[] }) => [i.message, ...i.turns.filter((t) => t.role === "user").map((t) => t.text)];

describe("HB-ERP domain-pack 계약", () => {
  it("팩이 검증을 통과하고 분량·분포를 지킨다", async () => {
    const pack = await loadDomainPack(PACK);
    expect(pack.chunks.length).toBeGreaterThanOrEqual(55);
    expect(pack.chunks.length).toBeLessThanOrEqual(65);
    expect(pack.faqs.length).toBeGreaterThanOrEqual(22);
    expect(pack.faqs.length).toBeLessThanOrEqual(28);
    for (const m of MODULES) {
      const n = pack.chunks.filter((c) => c.module === m).length;
      expect(n, m).toBeGreaterThanOrEqual(9);
      expect(pack.chunks.filter((c) => c.module === m && c.kind === "regulation").length, `${m} regulation`).toBeGreaterThanOrEqual(3);
      expect(pack.chunks.filter((c) => c.module === m && c.kind === "how_to").length, `${m} how_to`).toBeGreaterThanOrEqual(3);
    }
    for (const f of pack.faqs) {
      expect(f.variants.length, f.id).toBeGreaterThanOrEqual(3);
      expect(f.sourceChunkId, f.id).not.toBeNull();
    }
    for (const c of pack.chunks) expect([...c.text].length, c.id).toBeGreaterThanOrEqual(120);
  });

  it("가상 데이터 규칙: 예약된 연락처만", async () => {
    const pack = await loadDomainPack(PACK);
    expect(pack.manifest.helpdesk.email.endsWith(".example")).toBe(true);
    const all = JSON.stringify(pack);
    expect(all).not.toMatch(/\b01[016789]-?\d{3,4}-?\d{4}\b/); // 휴대전화 형식 금지
    expect(all).not.toMatch(/@(?!hanbit\.example)[a-z0-9-]+\.(com|co\.kr|net)/i);
  });

  it("tune 평가셋이 유형별 최소 개수와 팩 참조 규칙을 지킨다", async () => {
    const pack = await loadDomainPack(PACK);
    const items = await loadEvalSet(resolve(PACK, "eval/tune.jsonl"), pack);
    expect(items.length).toBeGreaterThanOrEqual(75);
    expect(items.length).toBeLessThanOrEqual(90);
    for (const [type, min] of Object.entries(MIN_TYPES)) expect(items.filter((i) => i.type === type).length, type).toBeGreaterThanOrEqual(min);
    for (const i of items.filter((x) => x.type === "followup")) expect(i.turns.length, i.id).toBeGreaterThanOrEqual(2);
  });

  it("tune의 사용자 문장이 FAQ variants·summary와 정규화 후 일치하지 않는다(BM25 문자열 일치 방지)", async () => {
    const pack = await loadDomainPack(PACK);
    const faqTexts = new Set(pack.faqs.flatMap((f) => [...f.variants, f.summary]).map(norm));
    const items = await loadEvalSet(resolve(PACK, "eval/tune.jsonl"), pack);
    const bad = items.filter((i) => userTexts(i).some((t) => faqTexts.has(norm(t)))).map((i) => i.id);
    expect(bad).toEqual([]);
  });

  it("holdout 파일이 있다면 tune과 ID·메시지가 겹치지 않는다(구현자는 holdout을 열지 않음 — 이 테스트는 하네스가 확인)", async () => {
    const holdout = resolve(PACK, "eval/holdout.jsonl");
    if (!existsSync(holdout)) return;
    const pack = await loadDomainPack(PACK);
    const [tune, hold] = await Promise.all([loadEvalSet(resolve(PACK, "eval/tune.jsonl"), pack), loadEvalSet(holdout, pack)]);
    const tuneIds = new Set(tune.map((i) => i.id));
    const tuneMsgs = new Set(tune.map((i) => i.message.trim()));
    // [E9] 실패해도 항목 내용·ID를 출력하지 않고 개수만 비교한다
    expect(hold.filter((i) => tuneIds.has(i.id) || tuneMsgs.has(i.message.trim())).length).toBe(0);
    // 같은 이유로 FAQ 문구와의 정규화 일치도 개수만 비교한다
    const faqTexts = new Set(pack.faqs.flatMap((f) => [...f.variants, f.summary]).map(norm));
    expect(hold.filter((i) => userTexts(i).some((t) => faqTexts.has(norm(t)))).length).toBe(0);
  });
});
