import type { Helpdesk } from "../domain/types";

export const MESSAGES = {
  regulationNotice: "본 안내는 규정 원문 기준입니다. 개별 금액·잔여 한도·기한 계산은 담당부서에 확인하세요.",
  multipleProvisions: "관련 조항이 여러 개입니다. 적용 조건을 확인하세요.",
  referenceIntro: "정확히 일치하는 규정은 찾지 못했습니다. 관련될 수 있는 문서입니다.",
  clarifyScope: "HB-ERP 관련 질문인지 조금 더 자세히 알려주세요.",
  clarifyAmbiguous: "어떤 항목을 말씀하시는지 구체적으로 알려주세요.",
  smalltalk: "안녕하세요! HB-ERP 규정이나 사용 방법을 물어보시면 안내해 드릴게요.",
  outOfScope: "죄송합니다. 저는 HB-ERP 규정과 사용 방법만 안내할 수 있어요.",
  fallback: "관련 규정을 찾지 못했습니다.",
  error: "일시적인 문제로 답변을 만들지 못했습니다. 잠시 후 다시 시도해주세요.",
  helpdesk: (h: Helpdesk) => `문의: 헬프데스크 ${h.phone} / ${h.email}${h.url ? ` / ${h.url}` : ""}`,
} as const;
