import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest globals가 꺼져 있어 Testing Library 자동 cleanup이 동작하지 않는다
afterEach(() => cleanup());

// jsdom에는 matchMedia가 없다(next-themes·sonner가 사용)
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
