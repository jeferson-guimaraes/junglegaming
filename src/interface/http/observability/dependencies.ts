import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { loadEnv } from '@/infrastructure/config/env';

/** Prazo de cada verificação: a prontidão precisa responder rápido mesmo com a dependência fora. */
const PRAZO_MS = 2000;

function comPrazo<T>(promessa: Promise<T>): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, reject) => {
    relogio = setTimeout(() => reject(new Error('prazo esgotado')), PRAZO_MS);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

/** Consultas diretas às dependências, usadas pela prontidão e pelas métricas de coleta. */
@Injectable()
export class Dependencies {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  async postgresUp(): Promise<boolean> {
    try {
      await comPrazo(this.orm.em.fork().getConnection().execute('select 1'));
      return true;
    } catch {
      return false;
    }
  }

  async sqsUp(): Promise<boolean> {
    try {
      await comPrazo(
        this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), {
          abortSignal: AbortSignal.timeout(PRAZO_MS),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Pendentes da outbox e idade, em segundos, do mais antigo. */
  async outbox(): Promise<{ pending: number; lagSeconds: number } | undefined> {
    try {
      const [row] = await comPrazo(
        this.orm.em
          .fork()
          .getConnection()
          .execute<{ pending: string; lag: string }[]>(
            `select count(*)::text as pending,
                    coalesce(extract(epoch from now() - min(occurred_at)), 0)::text as lag
               from outbox_messages where published_at is null`,
          ),
      );
      return { pending: Number(row?.pending ?? 0), lagSeconds: Math.max(0, Number(row?.lag ?? 0)) };
    } catch {
      return undefined;
    }
  }

  /** Mensagens na DLQ da fila de transações; undefined se a fila não existe ou o broker não responde. */
  async dlqDepth(): Promise<number | undefined> {
    try {
      const opcoes = { abortSignal: AbortSignal.timeout(PRAZO_MS) };
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: loadEnv().transactionsDlqName }),
        opcoes,
      );
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
        opcoes,
      );
      return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    } catch {
      return undefined;
    }
  }
}
