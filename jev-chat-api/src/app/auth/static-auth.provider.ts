import type { AuthedPrincipal, AuthProvider } from "./auth.types";

/** 테스트용: 토큰 → principal 고정 매핑 */
export class StaticTokenAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Record<string, AuthedPrincipal>) {}
  async verify(token: string): Promise<AuthedPrincipal | null> {
    return Object.hasOwn(this.tokens, token) ? this.tokens[token]! : null;
  }
}
