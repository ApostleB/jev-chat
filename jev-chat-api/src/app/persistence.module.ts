import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient } from "../adapters/persistence/prisma";
import { KnowledgeRepository } from "../adapters/persistence/knowledge.repository";
import { TurnRepository } from "../adapters/persistence/turn.repository";
import type { PrismaClient } from "../generated/prisma/client";
import { ENV, type Env } from "./config/env.schema";

export const PRISMA = Symbol("PRISMA");

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: (env: Env) =>
        createPrismaClient({
          host: env.DB_HOST,
          port: env.DB_PORT,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          database: env.DB_NAME,
          connectionLimit: env.DB_CONNECTION_LIMIT,
        }),
    },
    { provide: KnowledgeRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new KnowledgeRepository(p) },
    { provide: TurnRepository, inject: [PRISMA], useFactory: (p: PrismaClient) => new TurnRepository(p) },
  ],
  exports: [PRISMA, KnowledgeRepository, TurnRepository],
})
export class PersistenceModule implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}
  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
