import { ApiErrorSchema, type ErrorCode } from "@jev-chat/protocol";
import type { z } from "zod";

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request("GET", path, undefined, schema);
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request("POST", path, body, schema);
  }

  private async request<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const token = this.getToken();
    if (!token) throw new ApiRequestError(401, "UNAUTHORIZED", "접속 토큰을 먼저 입력하세요.");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiErrorSchema.safeParse(json);
      if (err.success) throw new ApiRequestError(res.status, err.data.error.code, err.data.error.message, err.data.error.retryAfterMs);
      throw new ApiRequestError(res.status, "INTERNAL", `요청 실패 (${res.status})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiRequestError(res.status, "INTERNAL", "서버 응답 형식이 올바르지 않습니다.");
    return parsed.data;
  }
}
