import type { ClientToServerEvents, ServerToClientEvents } from "@jev-chat/protocol";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudge, okRelevance, okTurn } from "../../core/testing/fakes";
import type { AuthProvider } from "../auth/auth.types";
import { createTestApp } from "../testing/test-app";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const enabled = !!process.env.TEST_DATABASE_URL;

/** [V1] 실제 소켓 연결에서 expiresAt이 지나면 서버가 연결을 끊는다 */
describe.runIf(enabled)("인증 만료 E2E (실제 소켓)", () => {
  let url: string;
  let close: () => Promise<void>;
  const clients: Client[] = [];

  beforeAll(async () => {
    const auth: AuthProvider = {
      verify: async (token) => {
        if (token === "short") return { userId: "u-short", roles: ["user"], expiresAt: Date.now() + 300 };
        if (token === "long") return { userId: "u-long", roles: ["user"], expiresAt: Date.now() + 3_600_000 };
        return null;
      },
    };
    const judge = new FakeJudge(async () => okTurn({ regulation: 1 }), async (req) => okRelevance(req.chunk.id, 0.1));
    ({ url, close } = await createTestApp({ judge, auth }));
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await close?.();
  });

  async function connect(token: string): Promise<Client> {
    const c: Client = io(`${url}/chat`, { auth: { token, protocolVersion: 1 }, transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: { origin: "http://localhost:5173" } });
    clients.push(c);
    await new Promise<void>((resolve, reject) => {
      c.once("connect", () => resolve());
      c.once("connect_error", reject);
    });
    return c;
  }

  it("짧은 expiresAt(+300ms)로 연결에 성공하고, 만료 후 서버가 연결을 끊는다", async () => {
    const c = await connect("short");
    expect(c.connected).toBe(true);
    const reason = await new Promise<string>((resolve) => c.once("disconnect", resolve));
    expect(reason).toBe("io server disconnect");
    expect(c.connected).toBe(false);
  });

  it("만료가 먼 연결은 유지된다", async () => {
    const c = await connect("long");
    await new Promise((r) => setTimeout(r, 600));
    expect(c.connected).toBe(true);
  });
});
