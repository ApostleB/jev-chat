import { describe, expect, it } from "vitest";
import { NoActiveKnowledgeError, SnapshotService, TemplateVersionMismatchError } from "./snapshot.service";
import type { ActiveKnowledge } from "../../adapters/persistence/knowledge.repository";
import { DEFAULT_INTENTS, DEFAULT_POLICY } from "../../core";

const make = (loader: ConstructorParameters<typeof SnapshotService>[0]) => new SnapshotService(loader, { limiterWaitMs: 3000 });

function active(versionId: string, text = "법인카드 1회 한도 50만 원"): ActiveKnowledge {
  return {
    versionId,
    pack: {
      manifest: { name: "t", version: "1", language: "ko", helpdesk: { phone: "1", email: "e" }, templateVersion: "v1" },
      policy: DEFAULT_POLICY,
      intents: DEFAULT_INTENTS,
    },
    chunks: [{ id: "c1", module: "m", kind: "regulation", title: "법인카드 규정", section: "한도", text, tags: [], updatedAt: "2026-01-01", contentHash: "h" }],
    faqs: [],
  };
}

describe("SnapshotService", () => {
  it("init 전 current()는 NoActiveKnowledgeError", () => {
    const s = make({ loadActive: async () => active("v1") });
    expect(() => s.current()).toThrow(NoActiveKnowledgeError);
  });

  it("init 후 활성 버전으로 스냅샷을 만든다", async () => {
    const s = make({ loadActive: async () => active("v1") });
    await s.init();
    const snap = s.current();
    expect(snap.knowledgeVersionId).toBe("v1");
    expect(snap.templateVersion).toBe("v1");
    expect(snap.retriever.searchChunks(["법인카드 한도"], 8)[0]?.chunk.id).toBe("c1");
    expect(snap.knowledge.getChunk("c1")?.title).toBe("법인카드 규정");
    expect(snap.helpdesk.phone).toBe("1");
  });

  it("active가 없으면 init은 성공하되 current()는 throw", async () => {
    const s = make({ loadActive: async () => null });
    await s.init();
    expect(() => s.current()).toThrow(NoActiveKnowledgeError);
  });

  it("reload는 참조를 통째로 교체한다 — 기존에 잡아둔 스냅샷은 그대로", async () => {
    let next = active("v1");
    const s = make({ loadActive: async () => next });
    await s.init();
    const held = s.current();
    next = active("v2");
    expect(await s.reload()).toEqual({ versionId: "v2", changed: true });
    expect(s.current().knowledgeVersionId).toBe("v2");
    expect(held.knowledgeVersionId).toBe("v1");
  });

  it("같은 버전이면 changed=false", async () => {
    const s = make({ loadActive: async () => active("v1") });
    await s.init();
    expect(await s.reload()).toEqual({ versionId: "v1", changed: false });
  });

  it("동시 reload는 한 번만 실행된다(single-flight)", async () => {
    let calls = 0;
    const s = make({
      loadActive: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return active("v1");
      },
    });
    await Promise.all([s.reload(), s.reload(), s.reload()]);
    expect(calls).toBe(1);
  });

  it("[P10] 스냅샷 policy의 limiterMs는 서버 설정값", async () => {
    const s = new SnapshotService({ loadActive: async () => active("v1") }, { limiterWaitMs: 1234 });
    await s.init();
    expect(s.current().policy.deadlines.limiterMs).toBe(1234);
  });

  it("[P10] 활성 팩의 template_version이 다르면 init 실패, reload는 이전 스냅샷 유지", async () => {
    const bad = active("v9");
    bad.pack.manifest.templateVersion = "v0";
    await expect(make({ loadActive: async () => bad }).init()).rejects.toBeInstanceOf(TemplateVersionMismatchError);
    let next = active("v1");
    const s = make({ loadActive: async () => next });
    await s.init();
    next = bad;
    await expect(s.reload()).rejects.toBeInstanceOf(TemplateVersionMismatchError);
    expect(s.current().knowledgeVersionId).toBe("v1");
  });

  it("reload 실패 시 이전 스냅샷을 유지하고 오류를 전달한다", async () => {
    let fail = false;
    const s = make({
      loadActive: async () => {
        if (fail) throw new Error("db down");
        return active("v1");
      },
    });
    await s.init();
    fail = true;
    await expect(s.reload()).rejects.toThrow("db down");
    expect(s.current().knowledgeVersionId).toBe("v1");
  });
});
