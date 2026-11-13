import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClockPort, IdGenerator, Metrics } from './application/ports';
import {
  GetWagerTransaction,
  ProcessWagerTransaction,
} from './application/process-wager-transaction';
import { PublishOutbox } from './application/publish-outbox';
import { ReprocessPendingReferences } from './application/reprocess-pending-references';
import { ListWalletLedger, ReconcileWallet } from './application/wallet-queries';
import { GetWallet, OpenWallet } from './application/wallets.use-cases';
import { loadEnv } from './infrastructure/config/env';
import { ShutdownHookLogger } from './infrastructure/lifecycle/shutdown-hook.logger';
import { correlationMiddleware } from './infrastructure/observability/correlation';
import { APP_LOGGER, createLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { SystemClock, UuidV7Generator } from './infrastructure/system-adapters';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { AuthGuard } from './interface/http/auth.guard';
import { ErrorFilter } from './interface/http/error.filter';
import { HealthController } from './interface/http/health/health.controller';
import { Dependencies } from './interface/http/observability/dependencies';
import { MetricsController } from './interface/http/observability/metrics.controller';
import { TransactionsController } from './interface/http/wagering/transactions.controller';
import { WalletsController } from './interface/http/wallets/wallets.controller';
import { WagerTransactionsConsumer } from './interface/sqs/wager-transactions.consumer';

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController, MetricsController, WalletsController, TransactionsController],
  providers: [
    { provide: APP_LOGGER, useFactory: () => createLogger({ level: loadEnv().logLevel }) },
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: ClockPort, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: Metrics, useClass: PrometheusMetrics },
    Dependencies,
    ListWalletLedger,
    ReconcileWallet,
    AuthGuard,
    OpenWallet,
    GetWallet,
    ProcessWagerTransaction,
    GetWagerTransaction,
    ReprocessPendingReferences,
    PendingReferenceWorker,
    PublishOutbox,
    OutboxPublisherWorker,
    WagerTransactionsConsumer,
    ShutdownHookLogger,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
