export const INTENT_IDS = ["regulation", "how_to", "error", "account_access", "smalltalk", "out_of_scope"] as const;
export type IntentId = (typeof INTENT_IDS)[number];
/** in_scope 합산에 들어가는 ERP 관련 의도 */
export const ERP_INTENTS: readonly IntentId[] = ["regulation", "how_to", "error", "account_access"];

export type ChunkKind = "regulation" | "how_to";

export interface Chunk {
  id: string;
  module: string;
  kind: ChunkKind;
  title: string;
  section: string;
  text: string;
  tags: string[];
  updatedAt: string;
  contentHash: string;
}

export interface Faq {
  id: string;
  intent: IntentId;
  summary: string;
  appliesWhen: string;
  answer: string;
  sourceChunkId: string | null;
  variants: string[];
}

export interface IntentDef {
  id: IntentId;
  description: string;
}

export interface Helpdesk {
  phone: string;
  email: string;
  url?: string;
}

export interface Policy {
  inScope: { block: number; clarify: number };
  ambiguous: number;
  faq: number;
  relevance: { reference: number; answer: number };
  helpdesk: number;
  candidates: { faq: number; chunk: number };
  context: { maxTurns: number; assistantMaxChars: number };
  deadlines: { engineMs: number; queueMs: number; limiterMs: number; saveMs: number };
}

export type Route = "faq" | "extractive" | "reference" | "clarify" | "blocked" | "fallback" | "error";

export type Role = "user" | "debug" | "admin";
export interface Principal {
  userId: string;
  roles: Role[];
}

/** 문맥으로 쓰는 완료된 턴 (turnSeq 오름차순) */
export interface CompletedTurn {
  turnSeq: number;
  userText: string;
  assistantText: string;
  sourceTitles: string[];
}

export interface SourceRef {
  chunkId: string;
  versionId: string;
  contentHash: string;
  title: string;
  section: string;
}
