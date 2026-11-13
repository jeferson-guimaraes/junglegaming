import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClockPort, IdGenerator } from './application/ports';
import { GetWallet, OpenWallet } from './application/wallets.use-cases';
import { loadEnv } from './infrastructure/config/env';
import { ShutdownHookLogger } from './infrastructure/lifecycle/shutdown-hook.logger';
import { correlationMiddleware } from './infrastructure/observability/correlation';
import { APP_LOGGER, createLogger } from './infrastructure/observability/logger';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { SystemClock, UuidV7Generator } from './infrastructure/system-adapters';
import { AuthGuard } from './interface/http/auth.guard';
import { ErrorFilter } from './interface/http/error.filter';
import { HealthController } from './interface/http/health/health.controller';
import { WalletsController } from './interface/http/wallets/wallets.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, WalletsController],
  providers: [
    { provide: APP_LOGGER, useFactory: () => createLogger({ level: loadEnv().logLevel }) },
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: ClockPort, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    AuthGuard,
    OpenWallet,
    GetWallet,
    ShutdownHookLogger,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
