import type { Principal, Role } from "../../core";

export const hasRole = (p: Principal, role: Role): boolean => p.roles.includes(role);
/** 열람: 본인 또는 admin */
export const canReadSession = (p: Principal, sessionUserId: string): boolean => p.userId === sessionUserId || hasRole(p, "admin");
/** 발송: 본인만(admin도 타인 세션에 보낼 수 없다) */
export const canWriteSession = (p: Principal, sessionUserId: string): boolean => p.userId === sessionUserId;
