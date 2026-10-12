import { Logger, Module } from "@nestjs/common";
import type { Judge } from "../core";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import { ChatGateway } from "./chat/chat.gateway";
import { ChatService } from "./chat/chat.service";
import { SlidingWindowRateLimiter } from "./chat/rate-limiter";
import { SessionQueue } from "./chat/session-queue";
import { JUDGE } from "./jev.module";
import { SnapshotService } from "./knowledge/snapshot.service";

const chatLog = new Logger("ChatService");

@Module({
  providers: [
    {
      provide: ChatService,
      inject: [TurnRepository, SnapshotService, JUDGE],
      useFactory: (store: TurnRepository, snapshots: SnapshotService, judge: Judge) =>
        new ChatService({
          store,
          snapshots,
          judge,
          queue: new SessionQueue({ capacity: 5 }),
          sendLimiter: new SlidingWindowRateLimiter(10, 60_000),
          sessionLimiter: new SlidingWindowRateLimiter(20, 60_000),
          replayLimiter: new SlidingWindowRateLimiter(30, 60_000),
          log: (where, err) => chatLog.error(`${where} 실패: ${(err as Error)?.name ?? "unknown"}`),
        }),
    },
    ChatGateway,
  ],
  exports: [ChatService],
})
export class ChatModule {}
