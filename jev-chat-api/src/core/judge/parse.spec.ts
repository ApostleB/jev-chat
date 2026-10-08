import { describe, expect, it } from "vitest";
import { JevResponseError, parseRelevanceAnswer, parseTurnAnswers } from "./parse";

const intentAnswer = {
  type: "choice",
  choice: "regulation",
  confidence: 0.9,
  probabilities: { regulation: 0.9, how_to: 0.05, error: 0.02, account_access: 0.01, smalltalk: 0.01, out_of_scope: 0.01 },
};

describe("parseTurnAnswers", () => {
  it("intent·ambiguous·faq를 도메인 값으로 매핑한다", () => {
    const r = parseTurnAnswers(
      {
        intent: intentAnswer,
        ambiguous: { type: "noul", noul: 0.12 },
        faq: { type: "choice", choice: "faq-a", confidence: 0.8, probabilities: { "faq-a": 0.85, none: 0.15 } },
      },
      ["faq-a"],
    );
    expect(r.intent.choice).toBe("regulation");
    expect(r.ambiguity).toBe(0.12);
    expect(r.faq?.choice).toBe("faq-a");
    expect(r.faq?.probabilities["faq-a"]).toBe(0.85);
  });
  it("faq 질문을 보내지 않았으면 faq는 null", () => {
    const r = parseTurnAnswers({ intent: intentAnswer, ambiguous: { type: "noul", noul: 0.1 } }, []);
    expect(r.faq).toBeNull();
  });
  it("후보에 없는 faq choice는 형식 오류", () => {
    expect(() =>
      parseTurnAnswers(
        {
          intent: intentAnswer,
          ambiguous: { type: "noul", noul: 0.1 },
          faq: { type: "choice", choice: "faq-zzz", confidence: 1, probabilities: { "faq-zzz": 1 } },
        },
        ["faq-a"],
      ),
    ).toThrow(JevResponseError);
  });
  it("알 수 없는 intent는 형식 오류", () => {
    expect(() =>
      parseTurnAnswers({ intent: { ...intentAnswer, choice: "weather" }, ambiguous: { type: "noul", noul: 0.1 } }, []),
    ).toThrow(JevResponseError);
  });
  it("확률에 빠진 intent는 0으로 채운다", () => {
    const r = parseTurnAnswers(
      { intent: { type: "choice", choice: "how_to", confidence: 1, probabilities: { how_to: 1 } }, ambiguous: { type: "noul", noul: 0 } },
      [],
    );
    expect(r.intent.probabilities.regulation).toBe(0);
  });
});

describe("parseRelevanceAnswer", () => {
  it("noul 값을 돌려준다", () => {
    expect(parseRelevanceAnswer({ relevant: { type: "noul", noul: 0.91 } })).toBe(0.91);
  });
  it("0~1 범위를 벗어나면 형식 오류", () => {
    expect(() => parseRelevanceAnswer({ relevant: { type: "noul", noul: 1.2 } })).toThrow(JevResponseError);
  });
  it("relevant가 없으면 형식 오류", () => {
    expect(() => parseRelevanceAnswer({})).toThrow(JevResponseError);
  });
});
