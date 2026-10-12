import { HttpException, HttpStatus } from "@nestjs/common";
import type { ErrorCode } from "@jev-chat/protocol";
import { ERROR_MESSAGES } from "../chat/turn-mapper";

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_INPUT: HttpStatus.BAD_REQUEST,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
};

export class ApiException extends HttpException {
  constructor(code: ErrorCode, retryAfterMs?: number) {
    super({ error: { code, message: ERROR_MESSAGES[code], ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }, STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
