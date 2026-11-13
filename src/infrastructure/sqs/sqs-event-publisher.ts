import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { EventPublisher } from '@/application/ports';
import type { OutboxMessage } from '@/domain/outbox-message';
import { loadEnv } from '../config/env';
import { ensureFifoQueue } from './queues';

/**
 * Publica os eventos na fila FIFO de eventos.
 * - `MessageDeduplicationId` = eventId: reenviar o mesmo evento dentro da janela do broker não
 *   gera segunda entrega (fora dela, quem consome descarta pelo `eventId` do envelope);
 * - `MessageGroupId` = wallet: os eventos de uma wallet são entregues na ordem de envio.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(private readonly client: SQSClient) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolverFila(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }

  /** Cria a fila se ainda não existir (operação idempotente) e guarda a URL. */
  private resolverFila(): Promise<string> {
    this.queueUrl ??= ensureFifoQueue(this.client, loadEnv().eventsQueueName).catch((erro) => {
      this.queueUrl = undefined; // não guarda a falha: a próxima publicação tenta de novo
      throw erro;
    });
    return this.queueUrl;
  }
}
