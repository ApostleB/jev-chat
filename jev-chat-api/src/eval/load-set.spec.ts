import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPack } from "../adapters/knowledge/pack-loader";
import { loadEvalSet } from "./load-set";

const MINI = resolve(process.cwd(), "src/adapters/knowledge/__fixtures__/mini-pack");
const file = (lines: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  const p = join(dir, "set.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
};
const ok = { id: "t-1", type: "normal", message: "법인카드 한도 얼마예요?", expect: { intent: "regulation", allowed_outcomes: ["ANSWER"], faq_ids: ["faq-card-limit"], attack_goal: null } };
const load = async (lines: unknown[]) => loadEvalSet(file(lines), await loadDomainPack(MINI));

describe("loadEvalSet", () => {
  it("정상 항목을 읽고 기본값을 채운다", async () => {
    const items = await load([ok]);
    expect(items[0]).toMatchObject({ id: "t-1", turns: [], expect: { allowed_outcomes: ["ANSWER"] } });
  });
  it("팩에 없는 FAQ·청크 ID를 거부(파일:줄), 메시지 본문은 오류에 넣지 않는다", async () => {
    const err = await load([{ ...ok, message: "비밀스러운-본문", expect: { ...ok.expect, faq_ids: ["faq-nope"] } }]).catch((e) => e);
    expect(String(err)).toMatch(/set\.jsonl:1.*faq-nope/s);
    expect(String(err)).not.toContain("비밀스러운-본문");
    await expect(load([{ ...ok, expect: { ...ok.expect, faq_ids: undefined, acceptable_chunk_ids: ["chunk-nope"], required_chunk_ids_any: ["chunk-nope"] } }])).rejects.toThrow(/chunk-nope/);
  });
  it("ID 중복·allowed_outcomes 비어 있음·알 수 없는 type 거부", async () => {
    await expect(load([ok, ok])).rejects.toThrow(/중복/);
    await expect(load([{ ...ok, expect: { ...ok.expect, allowed_outcomes: [] } }])).rejects.toThrow();
    await expect(load([{ ...ok, type: "weird" }])).rejects.toThrow();
  });
  it("[E7] 라벨 규칙", async () => {
    await expect(load([{ ...ok, type: "injection" }])).rejects.toThrow(/attack_goal/);
    await expect(load([{ ...ok, type: "injection", expect: { allowed_outcomes: ["ANSWER", "HOLD"], attack_goal: { outcome: "BLOCK" } } }])).rejects.toThrow(/정답 라벨/);
    await expect(load([{ ...ok, expect: { allowed_outcomes: ["ANSWER"], attack_goal: null } }])).rejects.toThrow(/정답 라벨/);
    await expect(load([{ ...ok, expect: { allowed_outcomes: ["ANSWER"], acceptable_chunk_ids: ["card-001"], required_chunk_ids_any: ["card-002"], attack_goal: null } }])).rejects.toThrow(/required/);
    await expect(load([{ ...ok, expect: { ...ok.expect, allowed_outcomes: ["ANSWER", "REFERENCE"] } }])).rejects.toThrow(/REFERENCE/);
    await expect(load([{ ...ok, turns: [{ role: "assistant", text: "a" }, { role: "user", text: "u" }] }])).rejects.toThrow(/turns/);
    await expect(load([{ ...ok, turns: [{ role: "user", text: "u" }] }])).rejects.toThrow(/turns/);
    await expect(load([{ ...ok, turns: [{ role: "user", text: "u", sources: ["card-001"] }, { role: "assistant", text: "a" }] }])).rejects.toThrow(/sources/);
  });
});
