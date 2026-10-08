const HANGUL = /\p{Script=Hangul}/u;
// 한글 연속 / 라틴·숫자 연속을 각각 하나의 조각으로 자른다.
const PIECE = /\p{Script=Hangul}+|[\p{Script=Latin}]+|\p{Nd}+/gu;

/** 검색용 토큰화: 한글은 문자 bigram, 영문은 소문자 단어, 숫자는 숫자열 그대로. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFC").toLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(PIECE)) {
    const piece = match[0];
    if (HANGUL.test(piece)) {
      const chars = [...piece];
      if (chars.length === 1) {
        tokens.push(piece);
        continue;
      }
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!);
    } else {
      tokens.push(piece);
    }
  }
  return tokens;
}
