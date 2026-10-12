import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest globals가 꺼져 있어 Testing Library 자동 cleanup이 동작하지 않는다
afterEach(() => cleanup());
