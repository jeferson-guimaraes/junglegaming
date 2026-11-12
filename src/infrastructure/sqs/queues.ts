import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueuePair {
  name: string;
  queueUrl: string;
  dlqName: string;
  dlqUrl: string;
}

interface FifoQueueWithDlqInput {
  name: string;
  dlqName: string;
  /** Recebimentos permitidos antes de o broker mover a mensagem para a DLQ. */
  maxReceiveCount: number;
}

async function createFifoQueue(
  client: SQSClient,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const saida = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...extra },
    }),
  );
  if (!saida.QueueUrl) throw new Error(`SQS não devolveu a URL da fila ${name}`);
  return saida.QueueUrl;
}

/** Cria uma fila FIFO simples. Se já existir com os mesmos atributos, devolve a URL. */
export async function ensureFifoQueue(client: SQSClient, name: string): Promise<string> {
  return createFifoQueue(client, name);
}

/**
 * Cria uma fila FIFO e a DLQ dela, ligadas por redrive policy.
 * Repetir com os mesmos atributos devolve as mesmas URLs; com atributos diferentes o broker
 * recusa (QueueNameExists), como na AWS, e a fila precisa ser recriada.
 */
export async function ensureFifoQueueWithDlq(
  client: SQSClient,
  input: FifoQueueWithDlqInput,
): Promise<QueuePair> {
  const dlqUrl = await createFifoQueue(client, input.dlqName);
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error(`SQS não devolveu o ARN da fila ${input.dlqName}`);

  const queueUrl = await createFifoQueue(client, input.name, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: input.maxReceiveCount,
    }),
  });

  return { name: input.name, queueUrl, dlqName: input.dlqName, dlqUrl };
}
