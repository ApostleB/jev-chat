import { Bm25Retriever, TEMPLATE_VERSION, type ExecutionSnapshot } from "../../core";
import type { ActiveKnowledge } from "../../adapters/persistence/knowledge.repository";
import { MapKnowledgeReader } from "../../adapters/knowledge/map-knowledge";

export class NoActiveKnowledgeError extends Error {
  constructor() {
    super("활성 지식 버전이 없습니다. pnpm knowledge:import를 먼저 실행하세요.");
    this.name = "NoActiveKnowledgeError";
  }
}

export class TemplateVersionMismatchError extends Error {
  constructor(packVersion: string) {
    super(`활성 지식 팩의 template_version(${packVersion})이 서버 코드(${TEMPLATE_VERSION})와 다릅니다. 팩을 갱신해 다시 import하세요.`);
    this.name = "TemplateVersionMismatchError";
  }
}

function buildSnapshot(a: ActiveKnowledge, limiterWaitMs: number): ExecutionSnapshot {
  // [P10] 재배포 후에도 활성 팩이 현재 질문 템플릿과 호환되는지 확인
  if (a.pack.manifest.templateVersion !== TEMPLATE_VERSION) throw new TemplateVersionMismatchError(a.pack.manifest.templateVersion);
  return {
    knowledgeVersionId: a.versionId,
    // [P10] 제한기 대기는 서버 설정값을 기록해 trace의 policy가 실제 동작과 일치하게 한다
    policy: { ...a.pack.policy, deadlines: { ...a.pack.policy.deadlines, limiterMs: limiterWaitMs } },
    intents: a.pack.intents,
    helpdesk: a.pack.manifest.helpdesk,
    templateVersion: TEMPLATE_VERSION,
    retriever: new Bm25Retriever(a.faqs, a.chunks),
    knowledge: new MapKnowledgeReader(a.versionId, a.chunks, a.faqs),
  };
}

/** 실행 스냅샷을 보관한다. 메시지 하나는 처리 시작 시 current()로 받은 스냅샷만 끝까지 쓴다. */
export class SnapshotService {
  private snapshot: ExecutionSnapshot | null = null;
  private inflight: Promise<{ versionId: string; changed: boolean }> | null = null;

  constructor(
    private readonly loader: { loadActive(): Promise<ActiveKnowledge | null> },
    private readonly opts: { limiterWaitMs: number },
  ) {}

  /** 활성 팩이 템플릿과 호환되지 않으면 TemplateVersionMismatchError로 부팅을 실패시킨다(조용히 잘못 동작하지 않음). */
  async init(): Promise<void> {
    const a = await this.loader.loadActive();
    if (a) this.snapshot = buildSnapshot(a, this.opts.limiterWaitMs);
  }

  current(): ExecutionSnapshot {
    if (!this.snapshot) throw new NoActiveKnowledgeError();
    return this.snapshot;
  }

  reload(): Promise<{ versionId: string; changed: boolean }> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const a = await this.loader.loadActive();
        if (!a) throw new NoActiveKnowledgeError();
        const prev = this.snapshot?.knowledgeVersionId ?? null;
        const next = buildSnapshot(a, this.opts.limiterWaitMs); // 빌드가 끝난 뒤에만 교체
        this.snapshot = next;
        return { versionId: a.versionId, changed: prev !== a.versionId };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
