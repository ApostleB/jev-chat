import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintKey, type Fingerprint } from "./fingerprint";
import type { ItemScore } from "./score";

export interface HoldoutResult {
  rc: string;
  fingerprint: Fingerprint;
  overallPass: boolean;
  rates: Record<string, number | null>;
  providerFailedIds: string[];
  scoresFile: string;
  scoresSha256: string;
  finishedAt: string;
}

type Status = "none" | "started" | "completed" | "rerun-started" | "rerun-completed";
const RC_RE = /^[a-z0-9][a-z0-9.-]{0,40}$/;

/** 파일을 'wx'(존재하면 실패)로 만들어 원자적으로 예약한다. 단일 머신 전제. */
export class HoldoutLedger {
  constructor(private readonly dir: string) {}

  private async createExclusive(name: string, body: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const fh = await open(join(this.dir, name), "wx");
    try {
      await fh.writeFile(JSON.stringify(body, null, 2) + "\n");
    } finally {
      await fh.close();
    }
  }

  private check(rc: string): void {
    if (!RC_RE.test(rc)) throw new Error("RC 이름은 소문자·숫자·점·하이픈 41자 이하");
  }

  /** [E6] 지문 키를 먼저 원자 예약하고(다른 RC 이름으로도 같은 지문 불가), 그다음 RC를 예약한다. */
  async reserve(rc: string, fp: Fingerprint): Promise<void> {
    this.check(rc);
    const fpFile = `fp-${fingerprintKey(fp)}.json`;
    await this.createExclusive(fpFile, { rc, fingerprint: fp, reservedAt: new Date().toISOString() });
    try {
      await this.createExclusive(`${rc}.start.json`, { rc, fingerprint: fp, startedAt: new Date().toISOString() });
    } catch (e) {
      await rm(join(this.dir, fpFile), { force: true }); // 방금 만든 지문 예약만 되돌린다
      throw e;
    }
  }
  async complete(rc: string, r: HoldoutResult): Promise<void> {
    await this.createExclusive(`${rc}.result.json`, r);
  }
  async reserveRerun(rc: string, fp: Fingerprint): Promise<void> {
    await this.createExclusive(`${rc}.rerun.start.json`, { rc, fingerprint: fp, startedAt: new Date().toISOString() });
  }
  async completeRerun(rc: string, r: HoldoutResult): Promise<void> {
    await this.createExclusive(`${rc}.rerun.result.json`, r);
  }

  private async files(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch {
      return [];
    }
  }

  async status(rc: string): Promise<Status> {
    this.check(rc);
    const f = new Set(await this.files());
    if (f.has(`${rc}.rerun.result.json`)) return "rerun-completed";
    if (f.has(`${rc}.rerun.start.json`)) return "rerun-started";
    if (f.has(`${rc}.result.json`)) return "completed";
    if (f.has(`${rc}.start.json`)) return "started";
    return "none";
  }

  async result(rc: string): Promise<HoldoutResult | null> {
    this.check(rc);
    try {
      return JSON.parse(await readFile(join(this.dir, `${rc}.result.json`), "utf8")) as HoldoutResult;
    } catch {
      return null;
    }
  }

  async findByFingerprint(fp: Fingerprint): Promise<string | null> {
    try {
      return (JSON.parse(await readFile(join(this.dir, `fp-${fingerprintKey(fp)}.json`), "utf8")) as { rc: string }).rc;
    } catch {
      return null;
    }
  }
}

export function decideHoldout(
  status: Status,
  mode: "first" | "rerun",
  existingFpRc: string | null,
  recorded?: HoldoutResult,
  current?: Fingerprint,
): { allowed: true } | { allowed: false; reason: string } {
  if (mode === "first") {
    if (status !== "none") return { allowed: false, reason: "이 RC는 이미 시작됐거나 완료됐습니다(중단된 실행도 재시도 불가 — 새 RC 필요)." };
    if (existingFpRc) return { allowed: false, reason: `같은 입력 지문으로 RC ${existingFpRc}가 이미 실행됐습니다(이름만 바꾼 반복 평가 금지).` };
    return { allowed: true };
  }
  if (status !== "completed") return { allowed: false, reason: "재실행은 완료된 RC에서, 재실행 기록이 없을 때 1회만 가능합니다." };
  if (!recorded || recorded.providerFailedIds.length === 0) return { allowed: false, reason: "외부 공급자 장애로 확인된 항목이 없습니다." };
  if (!current || JSON.stringify(recorded.fingerprint) !== JSON.stringify(current)) return { allowed: false, reason: "재실행은 원 실행과 같은 입력 지문(팩·holdout·템플릿·정책·커밋)이어야 합니다." };
  return { allowed: true };
}

/** 허용된 ID만 재실행 결과로 교체한다. 원 실행의 오답·내부 실패는 그대로 남는다. */
export function mergeRerun(original: ItemScore[], rerun: ItemScore[], allowedIds: string[]): ItemScore[] {
  const allowed = new Set(allowedIds);
  const byId = new Map(rerun.map((s) => [s.id, s]));
  return original.map((s) => (allowed.has(s.id) && byId.has(s.id) ? byId.get(s.id)! : s));
}
