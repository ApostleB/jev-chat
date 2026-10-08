import type { Chunk, Faq, Helpdesk, SourceRef } from "../domain/types";
import type { RouteDecision } from "../routing/router";
import { MESSAGES } from "./messages";

export interface KnowledgeReader {
  versionId: string;
  getChunk(id: string): Chunk | undefined;
  getFaq(id: string): Faq | undefined;
}

export interface AnswerInput {
  decision: RouteDecision;
  helpdesk: Helpdesk;
  showHelpdesk: boolean;
  knowledge: KnowledgeReader;
}

export interface AnswerOutput {
  text: string;
  sources: SourceRef[];
}

export interface Answerer {
  answer(input: AnswerInput, signal: AbortSignal): Promise<AnswerOutput>;
}

function toSource(chunk: Chunk, versionId: string): SourceRef {
  return { chunkId: chunk.id, versionId, contentHash: chunk.contentHash, title: chunk.title, section: chunk.section };
}

function quote(chunk: Chunk): string {
  return `[${chunk.title} · ${chunk.section}]\n${chunk.text}`;
}

export class ExtractiveAnswerer implements Answerer {
  async answer(input: AnswerInput, _signal?: AbortSignal): Promise<AnswerOutput> {
    const { decision, helpdesk, knowledge } = input;
    const helpdeskLine = MESSAGES.helpdesk(helpdesk);
    let body: string[] = [];
    let shown: Chunk[] = [];
    let helpdeskRequired = false;

    switch (decision.route) {
      case "error":
        return { text: MESSAGES.error, sources: [] };
      case "blocked":
        return { text: decision.variant === "smalltalk" ? MESSAGES.smalltalk : MESSAGES.outOfScope, sources: [] };
      case "clarify":
        return { text: decision.reason === "scope" ? MESSAGES.clarifyScope : MESSAGES.clarifyAmbiguous, sources: [] };
      case "fallback":
        body = [MESSAGES.fallback];
        helpdeskRequired = true;
        break;
      case "faq": {
        body = [decision.faq.answer];
        const src = decision.faq.sourceChunkId ? knowledge.getChunk(decision.faq.sourceChunkId) : undefined;
        if (src) shown = [src];
        break;
      }
      case "extractive": {
        shown = decision.chunks;
        body = shown.map(quote);
        if (new Set(shown.map((c) => c.title)).size > 1) {
          body.push(MESSAGES.multipleProvisions);
          helpdeskRequired = true;
        }
        break;
      }
      case "reference":
        shown = [decision.chunk];
        body = [MESSAGES.referenceIntro, quote(decision.chunk)];
        helpdeskRequired = true;
        break;
    }

    if (shown.some((c) => c.kind === "regulation")) body.push(MESSAGES.regulationNotice);
    if (helpdeskRequired || input.showHelpdesk) body.push(helpdeskLine);
    return { text: body.join("\n\n"), sources: shown.map((c) => toSource(c, knowledge.versionId)) };
  }
}
