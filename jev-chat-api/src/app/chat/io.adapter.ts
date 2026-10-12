import type { IncomingMessage } from "node:http";
import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { ServerOptions } from "socket.io";

/** [B5] Origin 허용 판정. Origin이 없는 비브라우저 클라이언트(CLI·서버 간)는 토큰 인증만으로 허용한다. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}

/** CORS(polling)와 handshake Origin(websocket 포함) 허용 목록을 env로 설정하는 IoAdapter */
export class ConfiguredIoAdapter extends IoAdapter {
  private readonly allowed: ReadonlySet<string>;

  constructor(app: INestApplicationContext, private readonly corsOrigins: string[]) {
    super(app);
    this.allowed = new Set(corsOrigins);
  }

  override createIOServer(port: number, options?: ServerOptions & { namespace?: string }) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins, credentials: false },
      maxHttpBufferSize: 16 * 1024,
      // CORS는 HTTP long-polling에만 적용된다. WebSocket까지 막으려면 handshake에서 직접 검사한다.
      allowRequest: (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
        callback(null, isAllowedOrigin(req.headers.origin, this.allowed));
      },
    } as ServerOptions);
  }
}
