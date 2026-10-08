import { Module, type DynamicModule } from "@nestjs/common";
import { ENV, type Env } from "./config/env.schema";
import { HealthController } from "./health.controller";

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
