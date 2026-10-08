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
  describe("Choice 엄격 검증", () => {
    const noul = { type: "noul", noul: 0.1 };
    const parseIntent = (intent: unknown) => parseTurnAnswers({ intent, ambiguous: noul }, []);
    const intentWith = (probabilities: Record<string, number>, choice = "regulation") => ({
      type: "choice",
      choice,
      confidence: 0.9,
      probabilities,
    });
    const full = { regulation: 0.9, how_to: 0.05, error: 0.02, account_access: 0.01, smalltalk: 0.01, out_of_scope: 0.01 };

    it("intent 확률 키가 누락되면 거부한다", () => {
      const { out_of_scope: _omit, ...five } = full;
      expect(() => parseIntent(intentWith({ ...five, regulation: 0.91 }))).toThrow(JevResponseError);
    });
    it("모르는 키가 추가되면 거부한다", () => {
      expect(() => parseIntent(intentWith({ ...full, regulation: 0.89, weather: 0.01 }))).toThrow(JevResponseError);
    });
    it("합계가 0.8이면 거부한다", () => {
      expect(() => parseIntent(intentWith({ ...full, regulation: 0.7 }))).toThrow(JevResponseError);
    });
    it("합계가 6이면 거부한다", () => {
      const ones = { regulation: 1, how_to: 1, error: 1, account_access: 1, smalltalk: 1, out_of_scope: 1 };
      expect(() => parseIntent(intentWith(ones))).toThrow(JevResponseError);
    });
    it("choice가 최고 확률이 아니면 거부한다", () => {
      const probs = { regulation: 0.1, how_to: 0, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0.9 };
      expect(() => parseIntent(intentWith(probs, "regulation"))).toThrow(JevResponseError);
    });
    it("NaN 확률은 거부한다", () => {
      expect(() => parseIntent(intentWith({ ...full, regulation: Number.NaN }))).toThrow(JevResponseError);
    });
    it("Infinity 확률은 거부한다", () => {
      expect(() => parseIntent(intentWith({ ...full, regulation: Number.POSITIVE_INFINITY }))).toThrow(JevResponseError);
    });
    it("faq 확률에 보내지 않은 FAQ id가 있으면 거부한다", () => {
      expect(() =>
        parseTurnAnswers(
          {
            intent: intentAnswer,
            ambiguous: noul,
            faq: { type: "choice", choice: "faq-a", confidence: 0.8, probabilities: { "faq-a": 0.7, "faq-zzz": 0.2, none: 0.1 } },
          },
          ["faq-a"],
        ),
      ).toThrow(JevResponseError);
    });
    it("confidence가 범위를 벗어나면 거부한다", () => {
      expect(() => parseIntent({ ...intentWith(full), confidence: 1.5 })).toThrow(JevResponseError);
      expect(() => parseIntent({ ...intentWith(full), confidence: Number.NaN })).toThrow(JevResponseError);
    });
    it("합계 0.995는 허용 오차 안이라 통과한다", () => {
      const r = parseIntent(intentWith({ ...full, regulation: 0.895 }));
      expect(r.intent.choice).toBe("regulation");
    });
    it("동점이면 둘 중 어느 쪽 choice든 허용한다", () => {
      const faqAnswer = (choice: string) => ({
        type: "choice",
        choice,
        confidence: 0.5,
        probabilities: { "faq-a": 0.5, none: 0.5 },
      });
      for (const choice of ["faq-a", "none"]) {
        const r = parseTurnAnswers({ intent: intentAnswer, ambiguous: noul, faq: faqAnswer(choice) }, ["faq-a"]);
        expect(r.faq?.choice).toBe(choice);
      }
    });
    it("경계값 0과 1을 허용한다", () => {
      const probs = { regulation: 1, how_to: 0, error: 0, account_access: 0, smalltalk: 0, out_of_scope: 0 };
      const r = parseTurnAnswers({ intent: { ...intentWith(probs), confidence: 0 }, ambiguous: { type: "noul", noul: 1 } }, []);
      expect(r.intent.probabilities.regulation).toBe(1);
      expect(r.intent.confidence).toBe(0);
      expect(r.ambiguity).toBe(1);
    });
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
