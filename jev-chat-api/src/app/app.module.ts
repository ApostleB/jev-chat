import { Module, type DynamicModule, type OnApplicationBootstrap, Inject } from "@nestjs/common";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import { ENV, type Env } from "./config/env.schema";
import { HealthController } from "./health.controller";
import { JevModule } from "./jev.module";
import { SnapshotService } from "./knowledge/snapshot.service";
import { PersistenceModule } from "./persistence.module";

@Module({})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(TurnRepository) private readonly turns: TurnRepository,
  ) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [PersistenceModule, JevModule],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: SnapshotService,
          inject: [KnowledgeRepository],
          useFactory: (repo: KnowledgeRepository) => new SnapshotService(repo, { limiterWaitMs: env.JEV_LIMITER_WAIT_MS }),
        },
      ],
      exports: [ENV, SnapshotService],
    };
  }

  /** 부팅 시: 재시작 전 처리 중이던 턴 정리 → 활성 지식 스냅샷 로드 */
  async onApplicationBootstrap(): Promise<void> {
    await this.turns.sweepProcessing("RESTARTED");
    await this.snapshots.init();
  }
}
