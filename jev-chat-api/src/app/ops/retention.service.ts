import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { TurnRepository } from "../../adapters/persistence/turn.repository";
import { ENV, type Env } from "../config/env.schema";

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(@Inject(TurnRepository) private readonly turns: TurnRepository, @Inject(ENV) private readonly env: Env) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === "test") return;
    const first = setTimeout(() => void this.sweep(), 60_000);
    const daily = setInterval(() => void this.sweep(), DAY);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearTimeout(t));
  }

  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.env.RETENTION_DAYS * DAY);
    try {
      const r = await this.turns.deleteOlderThan(cutoff);
      if (r.turns + r.sessions > 0) this.log.log(`보관 기간(${this.env.RETENTION_DAYS}일) 정리: 턴 ${r.turns}건, 빈 세션 ${r.sessions}건`);
      return r.turns;
    } catch (e) {
      this.log.error(`보관 기간 정리 실패: ${(e as Error).name}`);
      return 0;
    }
  }
}
