import type { Principal, Role } from "../../core";

export const hasRole = (p: Principal, role: Role): boolean => p.roles.includes(role);
export const canAccessSession = (p: Principal, sessionUserId: string): boolean => p.userId === sessionUserId || hasRole(p, "admin");
