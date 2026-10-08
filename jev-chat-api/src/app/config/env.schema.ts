import { z } from "zod";

const int = (def: number) => z.coerce.number().int().positive().default(def);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: int(3000),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
    AUTH_MODE: z.enum(["dev"]).default("dev"),
    DEV_ACCESS_TOKEN: z.string().optional(),
    TYPESAFE_API_KEY: z.string().min(1),
    TYPESAFE_BASE_URL: z.url().optional(),
    JEV_ATTEMPT_TIMEOUT_MS: int(5000),
    JEV_MAX_CONCURRENT: int(40),
    JEV_MAX_RPS: int(70),
    JEV_MAX_TPS: int(80000),
    JEV_LIMITER_WAIT_MS: int(3000),
    JEV_MAX_RETRY_WAIT_MS: int(2000),
    DB_HOST: z.string().min(1),
    DB_PORT: int(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string(),
    DB_NAME: z.string().min(1),
    DB_CONNECTION_LIMIT: int(10),
    DOMAIN_PACK_DIR: z.string().default("domain-pack/hanbit-erp"),
    RETENTION_DAYS: int(90),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["AUTH_MODE"], message: "production에서는 AUTH_MODE=dev를 사용할 수 없습니다." });
    }
    if (env.AUTH_MODE === "dev" && (env.DEV_ACCESS_TOKEN ?? "").length < 32) {
      ctx.addIssue({ code: "custom", path: ["DEV_ACCESS_TOKEN"], message: "AUTH_MODE=dev에는 32자 이상의 DEV_ACCESS_TOKEN이 필요합니다." });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
export const ENV = Symbol("ENV");

/** 실패 시 경로와 메시지만 담은 오류를 던진다(입력 값은 포함하지 않음). */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`환경 변수 검증 실패\n${lines.join("\n")}`);
  }
  return parsed.data;
}
