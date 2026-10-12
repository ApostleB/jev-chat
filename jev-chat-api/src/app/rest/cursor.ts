import { z } from "zod";

/** 세션·검수 큐 커서: `<ISO 시각>|<uuid>` */
export const TimeIdCursor = z
  .string()
  .max(200)
  .refine((c) => {
    const [at, id, ...rest] = c.split("|");
    return (
      rest.length === 0 &&
      !!at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at) && !Number.isNaN(Date.parse(at)) &&
      !!id && z.uuid().safeParse(id).success
    );
  }, "잘못된 커서");

/** 지식 목록 커서: 청크/FAQ id */
export const IdCursor = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "잘못된 커서");

/** 관리 API 공유 제한(사용자당 분당 30건) 주입 토큰 */
export const ADMIN_LIMITER = Symbol("ADMIN_LIMITER");
