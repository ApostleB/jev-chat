import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { JevRequest } from "../../core";
import { SdkJevTransport } from "./sdk-transport";

const payload: JevRequest = {
  model: "jev-1.13.0",
  state: { employee_message: "x" },
  questions: { relevant: { type: "noul", instructions: "Q?", criteria: { true: "t", false: "f" } } },
};

/** 응답 헤더(와 본문 일부)만 보내고 멈추는 로컬 서버 — 본문 수신 중 abort를 재현한다. */
async function startStallingServer(mode: "headers-only" | "partial-body") {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    res.flushHeaders();
    if (mode === "partial-body") res.write('{"mo');
  });
  server.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

describe("SdkJevTransport: 본문 수신 중 abort", () => {
  const closers: (() => void)[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
    for (const l of listeners.splice(0)) process.off("unhandledRejection", l);
  });

  for (const mode of ["headers-only", "partial-body"] as const) {
    for (const how of ["caller-abort", "caller-timeout-signal"] as const) {
      it(`${mode} / ${how}: aborted로 끝나고 unhandledRejection이 없다`, async () => {
        const seen: unknown[] = [];
        const l = (e: unknown) => seen.push(e);
        listeners.push(l);
        process.on("unhandledRejection", l);
        const srv = await startStallingServer(mode);
        closers.push(srv.close);
        const t = new SdkJevTransport({ apiKey: "test-key", baseURL: srv.baseURL });
        const ctrl = new AbortController();
        const signal = how === "caller-abort" ? ctrl.signal : AbortSignal.timeout(60);
        if (how === "caller-abort") setTimeout(() => ctrl.abort(), 60);
        const err = await t.send(payload, { signal, timeoutMs: 5000 }).catch((e) => e);
        expect(err).toMatchObject({ kind: "aborted" });
        await new Promise((r) => setTimeout(r, 300));
        expect(seen).toEqual([]);
      });
    }
  }
});
