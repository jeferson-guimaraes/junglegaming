import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadEnv } from '@/infrastructure/config/env';
import { createSqsClient } from '@/infrastructure/sqs/sqs.client';

export function sqsDeTeste(): SQSClient {
  return createSqsClient(loadEnv());
}

export async function urlDaFila(client: SQSClient, nome: string): Promise<string> {
  const saida = await client.send(new GetQueueUrlCommand({ QueueName: nome }));
  if (!saida.QueueUrl) throw new Error(`fila ${nome} não encontrada`);
  return saida.QueueUrl;
}

/**
 * Recebe e apaga mensagens até a fila ficar vazia por `ociosoMs`, ou até atingir `esperadas`.
 * Apagar cada mensagem libera o grupo FIFO para a próxima.
 */
export async function drenar(
  client: SQSClient,
  queueUrl: string,
  opcoes: { esperadas?: number; prazoMs?: number } = {},
): Promise<Message[]> {
  const recebidas: Message[] = [];
  const limite = Date.now() + (opcoes.prazoMs ?? 5000);
  while (Date.now() < limite && recebidas.length < (opcoes.esperadas ?? Number.POSITIVE_INFINITY)) {
    const saida = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
        MessageAttributeNames: ['All'],
      }),
    );
    const lote = saida.Messages ?? [];
    if (lote.length === 0 && opcoes.esperadas === undefined) break;
    for (const mensagem of lote) {
      recebidas.push(mensagem);
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    }
  }
  return recebidas;
}

export async function apagarFila(client: SQSClient, nome: string): Promise<void> {
  try {
    await client.send(new DeleteQueueCommand({ QueueUrl: await urlDaFila(client, nome) }));
  } catch {
    // a fila pode nunca ter sido criada
  }
}

/** Espera uma condição ficar verdadeira, consultando de tempos em tempos. */
export async function esperar<T>(
  condicao: () => Promise<T | undefined | false>,
  prazoMs = 10_000,
  descricao = 'condição',
): Promise<T> {
  const limite = Date.now() + prazoMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() > limite) throw new Error(`prazo esgotado esperando: ${descricao}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function esperarFila(client: SQSClient, nome: string): Promise<string> {
  return esperar(() => urlDaFila(client, nome).catch(() => undefined), 10_000, `fila ${nome}`);
}

/** Envia um corpo cru para a fila FIFO, no grupo informado. */
export async function enviarCru(
  client: SQSClient,
  queueUrl: string,
  corpo: string,
  grupo: string,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: corpo,
      MessageGroupId: grupo,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
