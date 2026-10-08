// 별도 프로세스(node --expose-gc)에서 실행되는 프로브: 반환된 signal만 쥐고 GC를 반복해도 부모 타임아웃이 전파되어야 한다.
import { linkedController } from "../../src/core/engine/abort";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error("--expose-gc 필요");
  process.exit(2);
}

const { signal } = linkedController(AbortSignal.timeout(300));
const gcTimer = setInterval(() => gc(), 25);
const deadline = setTimeout(() => {
  console.error("1초 안에 abort되지 않음");
  process.exit(1);
}, 1000);
signal.addEventListener("abort", () => {
  clearInterval(gcTimer);
  clearTimeout(deadline);
  process.exit(0);
});
