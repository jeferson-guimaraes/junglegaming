import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { loadEnv } from './infrastructure/config/env';
import { ShutdownHookLogger } from './infrastructure/lifecycle/shutdown-hook.logger';
import { correlationMiddleware } from './infrastructure/observability/correlation';
import { APP_LOGGER, createLogger } from './infrastructure/observability/logger';
import { HealthController } from './interface/http/health/health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_LOGGER, useFactory: () => createLogger({ level: loadEnv().logLevel }) },
    ShutdownHookLogger,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
