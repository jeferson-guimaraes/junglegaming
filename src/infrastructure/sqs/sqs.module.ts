import { SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { EventPublisher } from '@/application/ports';
import { loadEnv } from '../config/env';
import { createSqsClient } from './sqs.client';
import { SqsEventPublisher } from './sqs-event-publisher';

@Injectable()
class SqsShutdown implements OnApplicationShutdown {
  constructor(private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Module({
  providers: [
    { provide: SQSClient, useFactory: () => createSqsClient(loadEnv()) },
    { provide: EventPublisher, useClass: SqsEventPublisher },
    SqsShutdown,
  ],
  exports: [SQSClient, EventPublisher],
})
export class SqsModule {}
