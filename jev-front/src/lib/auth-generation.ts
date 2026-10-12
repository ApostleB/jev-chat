/**
 * 인증 세대. 로그아웃·토큰 교체 때 증가시킨다 [F2].
 * 진행 중이던 mutation이 나중에 끝나도, 시작 시점의 세대와 달라졌으면 UI 콜백(toast 등)을 실행하지 않는다.
 * (이미 서버에 도달한 변경이 취소된다고 가정하지 않는다 — 화면 반응만 막는다.)
 */
let generation = 0;

export function markAuthChanged(): void {
  generation++;
}

/** 호출 시점의 세대를 잡아 두고, 나중에 "아직 같은 세대인가"를 돌려주는 함수를 만든다 */
export function captureAuthGeneration(): () => boolean {
  const g = generation;
  return () => g === generation;
}
