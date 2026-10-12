import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthedPrincipal, AuthProvider } from "./auth.types";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** MVP 공유 테스트 관리자 계정. production에서는 env 검증 단계에서 시작이 거부된다. */
export class DevAuthProvider implements AuthProvider {
  private readonly expected: Buffer;

  constructor(expectedToken: string) {
    if (expectedToken.length < 32) throw new Error("DEV_ACCESS_TOKEN은 32자 이상이어야 합니다.");
    this.expected = digest(expectedToken);
  }

  async verify(token: string): Promise<AuthedPrincipal | null> {
    if (!token) return null;
    // 길이에 무관한 상수 시간 비교를 위해 해시끼리 비교한다
    return timingSafeEqual(digest(token), this.expected) ? { userId: "dev-admin", roles: ["user", "debug", "admin"] } : null;
  }
}
