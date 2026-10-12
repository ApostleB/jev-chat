import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { ErrorCode } from "@jev-chat/protocol";
import { ERROR_MESSAGES } from "../chat/turn-mapper";

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return status < 500 ? "INVALID_INPUT" : "INTERNAL";
}

/** 모든 HTTP 오류를 ApiError 형식({ error: { code, message } })으로 통일한다. 스택·내부 메시지는 응답에 넣지 않는다. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("HTTP");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(body: unknown): void } }>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "object" && (body as { error: unknown }).error !== null) {
        res.status(status).json(body);
        return;
      }
      const code = codeForStatus(status);
      res.status(status).json({ error: { code, message: ERROR_MESSAGES[code] } });
      return;
    }
    // body-parser 오류(413 entity.too.large, 400 JSON 파싱 실패)는 status 속성을 가진다
    const status = (exception as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT } });
      return;
    }
    this.log.error(`처리되지 않은 예외: ${(exception as Error)?.name ?? "unknown"}`);
    res.status(500).json({ error: { code: "INTERNAL", message: ERROR_MESSAGES.INTERNAL } });
  }
}
