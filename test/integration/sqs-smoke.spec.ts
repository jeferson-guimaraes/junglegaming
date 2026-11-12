import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadEnv } from '@/infrastructure/config/env';
import { ensureFifoQueueWithDlq, type QueuePair } from '@/infrastructure/sqs/queues';
import { createSqsClient } from '@/infrastructure/sqs/sqs.client';

const MAX_RECEIVE_COUNT = 2;

describe('SQS no MiniStack (fumaça)', () => {
  let client: SQSClient;
  /** Um par de filas novo por teste: nenhum caso herda mensagens de outro. */
  let filas: QueuePair;

  async function enviar(
    corpo: string,
    grupo: string,
    dedup: string = randomUUID(),
  ): Promise<string | undefined> {
    const saida = await client.send(
      new SendMessageCommand({
        QueueUrl: filas.queueUrl,
        MessageBody: corpo,
        MessageGroupId: grupo,
        MessageDeduplicationId: dedup,
      }),
    );
    return saida.MessageId;
  }

  async function receber(
    queueUrl: string,
    opcoes: { espera?: number; maximo?: number; visibilidade?: number } = {},
  ): Promise<Message[]> {
    const saida = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: opcoes.maximo ?? 10,
        WaitTimeSeconds: opcoes.espera ?? 1,
        VisibilityTimeout: opcoes.visibilidade ?? 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return saida.Messages ?? [];
  }

  async function devolver(mensagem: Message): Promise<void> {
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: filas.queueUrl,
        ReceiptHandle: mensagem.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  beforeAll(() => {
    client = createSqsClient(loadEnv());
  });

  afterAll(() => {
    client?.destroy();
  });

  beforeEach(async () => {
    const sufixo = randomUUID().slice(0, 8);
    filas = await ensureFifoQueueWithDlq(client, {
      name: `fumaca-${sufixo}.fifo`,
      dlqName: `fumaca-${sufixo}-dlq.fifo`,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    });
  });

  afterEach(async () => {
    await Promise.allSettled([
      client.send(new DeleteQueueCommand({ QueueUrl: filas.queueUrl })),
      client.send(new DeleteQueueCommand({ QueueUrl: filas.dlqUrl })),
    ]);
  });

  it('criar as filas de novo com os mesmos atributos devolve as mesmas URLs', async () => {
    const outraVez = await ensureFifoQueueWithDlq(client, {
      name: filas.name,
      dlqName: filas.dlqName,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    });

    expect(outraVez.queueUrl).toBe(filas.queueUrl);
    expect(outraVez.dlqUrl).toBe(filas.dlqUrl);
  });

  it('entrega mensagem FIFO com o grupo informado', async () => {
    await enviar('ola', 'wallet-1');

    const mensagens = await receber(filas.queueUrl);

    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]?.Body).toBe('ola');
    expect(mensagens[0]?.Attributes?.MessageGroupId).toBe('wallet-1');
  });

  it('descarta envio repetido com o mesmo MessageDeduplicationId', async () => {
    const dedup = randomUUID();

    const primeiroId = await enviar('unica', 'wallet-2', dedup);
    const segundoId = await enviar('unica', 'wallet-2', dedup);
    const mensagens = await receber(filas.queueUrl);

    // O broker reconhece o reenvio e devolve o id da mensagem original...
    expect(segundoId).toBe(primeiroId);
    // ...e uma única chamada, que traria as duas se existissem, traz só uma.
    expect(mensagens.map((m) => m.MessageId)).toEqual([primeiroId]);
  });

  it('não entrega a próxima mensagem do grupo enquanto a anterior está em voo', async () => {
    await enviar('primeira', 'wallet-3');
    await enviar('segunda', 'wallet-3');
    await enviar('de-outro-grupo', 'wallet-4');

    // Um consumidor pega a primeira mensagem do grupo wallet-3 e ainda não confirmou.
    const emVoo = await receber(filas.queueUrl, { maximo: 1 });
    expect(emVoo.map((m) => m.Body)).toEqual(['primeira']);

    // Outro consumidor só recebe o que é de outros grupos.
    const outroConsumidor = await receber(filas.queueUrl);
    expect(outroConsumidor.map((m) => m.Body)).toEqual(['de-outro-grupo']);
  });

  it('visibilidade zero devolve a mensagem e incrementa o contador de recebimentos', async () => {
    await enviar('volta', 'wallet-5');

    const [primeira] = await receber(filas.queueUrl);
    expect(primeira?.Attributes?.ApproximateReceiveCount).toBe('1');
    if (!primeira) throw new Error('mensagem não recebida');
    await devolver(primeira);

    const [segunda] = await receber(filas.queueUrl);
    expect(segunda?.Body).toBe('volta');
    expect(segunda?.Attributes?.ApproximateReceiveCount).toBe('2');
  });

  it('mensagem não confirmada reaparece sozinha quando a visibilidade expira', async () => {
    await enviar('consumidor-morreu', 'wallet-7');

    const [primeira] = await receber(filas.queueUrl, { visibilidade: 1 });
    expect(primeira?.Body).toBe('consumidor-morreu');
    // Nenhum ack nem devolução: simula o processo que morre com a mensagem em mãos.

    const [segunda] = await receber(filas.queueUrl, { espera: 3 });
    expect(segunda?.Body).toBe('consumidor-morreu');
    expect(segunda?.Attributes?.ApproximateReceiveCount).toBe('2');
  });

  it('redrive: após maxReceiveCount recebimentos a mensagem vai para a DLQ', async () => {
    await enviar('veneno', 'wallet-6');

    for (let i = 0; i < MAX_RECEIVE_COUNT; i++) {
      const [mensagem] = await receber(filas.queueUrl);
      if (!mensagem) throw new Error(`recebimento ${i + 1} não entregou a mensagem`);
      await devolver(mensagem);
    }

    const naOrigem = await receber(filas.queueUrl);
    const naDlq = await receber(filas.dlqUrl, { espera: 2 });

    expect(naOrigem).toHaveLength(0);
    expect(naDlq.map((m) => m.Body)).toEqual(['veneno']);
  });
});
