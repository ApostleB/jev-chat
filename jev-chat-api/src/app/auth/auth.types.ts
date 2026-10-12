import type { Principal } from "../../core";

export interface AuthedPrincipal extends Principal {
  /** epoch ms. 지나면 서버가 연결을 끊는다 */
  expiresAt?: number;
}

export interface AuthProvider {
  verify(token: string): Promise<AuthedPrincipal | null>;
}

export const AUTH_PROVIDER = Symbol("AUTH_PROVIDER");
