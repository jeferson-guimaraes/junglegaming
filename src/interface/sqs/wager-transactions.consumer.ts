import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '@/application/errors';
import { Metrics } from '@/application/ports';
import { ProcessWagerTransaction } from '@/application/process-wager-transaction';
import { type Env, loadEnv } from '@/infrastructure/config/env';
import { newCorrelationId, runWithCorrelation } from '@/infrastructure/observability/correlation';
import { APP_LOGGER, type AppLogger } from '@/infrastructure/observability/logger';
import { ensureFifoQueueWithDlq, type QueuePair } from '@/infrastructure/sqs/queues';
import { objeto, texto } from '../validation';
import { parseWagerTransaction, type WagerTransactionInput } from '../wager-transaction.input';

export const CONSUMER_NAME = 'wager-transactions';
const TIPO_ACEITO = 'WagerTransactionRequested';
/** Teto do intervalo antes da reentrega após falha transitória. */
const ATRASO_MAXIMO_SEGUNDOS = 300;

interface Pedido {
  messageId: string;
  input: WagerTransactionInput;
}

/** Envelope da fila → pedido validado. Lança InvalidPayloadError (erro permanente). */
export function parseMessage(body: string | undefined): Pedido {
  let envelope: Record<string, unknown>;
  try {
    envelope = objeto(JSON.parse(body ?? ''), 'mensagem');
  } catch (erro) {
    if (erro instanceof InvalidPayloadError) throw erro;
    throw new InvalidPayloadError('a mensagem não é um JSON válido');
  }
  const messageId = texto(envelope.messageId, 'messageId');
  if (envelope.type !== TIPO_ACEITO) {
    throw new InvalidPayloadError(`type deve ser ${TIPO_ACEITO}`);
  }
  const data = objeto(envelope.data, 'data');
  return { messageId, input: parseWagerTransaction(data, data.idempotencyKey) };
}

/**
 * Consumer da fila de transações. Usa o mesmo caso de uso da API HTTP.
 *
 * Destino de cada mensagem:
 * - processada, rejeitada por regra de negócio, pendente de referência, repetida (inbox) ou
 *   em conflito de idempotência → apagada (ack), sempre depois do commit;
 * - falha transitória ou erro inesperado → continua na fila e volta depois de um intervalo
 *   crescente; ao atingir o limite de recebimentos, o broker a move para a DLQ;
 * - erro permanente (mensagem inválida, wallet inexistente, mesmo messageId com outro
 *   conteúdo) → enviada à DLQ e apagada na hora, para não travar o grupo FIFO da wallet.
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly env: Env = loadEnv();
  private ativo = false;
  private laco: Promise<void> | undefined;
  private recebimento: AbortController | undefined;
  private filas: QueuePair | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly processTransaction: ProcessWagerTransaction,
    private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.consumerEnabled) return;
    this.ativo = true;
    this.laco = this.consumir();
  }

  /**
   * Encerramento: para de buscar mensagens, conclui a que está em andamento em cada grupo e
   * devolve à fila as que foram recebidas mas ainda não começaram. Roda antes de o pool do
   * banco e o cliente SQS serem fechados.
   */
  async onModuleDestroy(): Promise<void> {
    this.ativo = false;
    this.recebimento?.abort();
    await this.laco;
  }

  private async consumir(): Promise<void> {
    while (this.ativo) {
      try {
        const filas = await this.resolverFilas();
        const mensagens = await this.receber(filas.queueUrl);
        await this.processarLote(filas, mensagens);
      } catch (err) {
        if (!this.ativo) return;
        this.logger.warn({ err: (err as Error)?.name }, 'consumer: falha ao receber mensagens');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async resolverFilas(): Promise<QueuePair> {
    this.filas ??= await ensureFifoQueueWithDlq(this.client, {
      name: this.env.transactionsQueueName,
      dlqName: this.env.transactionsDlqName,
      maxReceiveCount: this.env.consumerMaxReceiveCount,
    });
    return this.filas;
  }

  private async receber(queueUrl: string): Promise<Message[]> {
    this.recebimento = new AbortController();
    if (!this.ativo) return []; // o encerramento chegou antes de este recebimento começar
    const saida = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.env.consumerWaitTimeSeconds,
        VisibilityTimeout: this.env.consumerVisibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.recebimento.signal },
    );
    return saida.Messages ?? [];
  }

  /** Grupos (wallets) diferentes em paralelo; dentro de um grupo, na ordem de chegada. */
  private async processarLote(filas: QueuePair, mensagens: Message[]): Promise<void> {
    const grupos = new Map<string, Message[]>();
    for (const mensagem of mensagens) {
      const grupo = mensagem.Attributes?.MessageGroupId ?? '';
      grupos.set(grupo, [...(grupos.get(grupo) ?? []), mensagem]);
    }
    await Promise.all(
      [...grupos.values()].map(async (doGrupo) => {
        let interromper = false;
        for (const mensagem of doGrupo) {
          if (interromper || !this.ativo) {
            // Encerrando, ou a anterior do grupo falhou: devolve sem processar, mantendo a ordem.
            await this.devolver(filas, mensagem, 0);
            continue;
          }
          try {
            interromper = !(await this.tratar(filas, mensagem));
          } catch (err) {
            // Falha ao confirmar ou ao enviar à DLQ: a mensagem fica na fila e volta quando a
            // visibilidade expirar. Se o efeito já foi gravado, o inbox absorve a reentrega.
            interromper = true;
            this.logger.warn(
              { sqsMessageId: mensagem.MessageId, err: (err as Error)?.name },
              'consumer: falha ao concluir a mensagem; ela volta à fila',
            );
          }
        }
      }),
    );
  }

  /** Devolve false quando a mensagem ficou na fila para nova tentativa. */
  private async tratar(filas: QueuePair, mensagem: Message): Promise<boolean> {
    let pedido: Pedido;
    try {
      pedido = parseMessage(mensagem.Body);
    } catch (erro) {
      await this.enviarParaDlq(filas, mensagem, (erro as InvalidPayloadError).code, erro);
      return true;
    }

    return runWithCorrelation(newCorrelationId(), async () => {
      try {
        const resultado = await this.processTransaction.execute(
          {
            ...pedido.input,
            correlationId: newCorrelationId(),
            causationId: pedido.messageId,
          },
          { consumerName: CONSUMER_NAME, messageId: pedido.messageId },
        );
        // Ponto de falha injetável (só em teste): o processo morre depois do commit, sem ack.
        if (this.env.faultExitBeforeAck) process.exit(86);
        await this.apagar(filas.queueUrl, mensagem);
        this.logger.info(
          {
            messageId: pedido.messageId,
            transactionId: resultado.transaction.id,
            walletId: resultado.transaction.walletId,
            providerId: resultado.transaction.providerId,
            status: resultado.transaction.status,
            repetida: resultado.duplicateMessage === true,
          },
          'consumer: mensagem processada',
        );
        return true;
      } catch (erro) {
        if (erro instanceof IdempotencyConflictError) {
          // Erro de negócio: reentregar não muda o resultado.
          await this.apagar(filas.queueUrl, mensagem);
          this.logger.warn(
            { messageId: pedido.messageId, code: erro.code },
            'consumer: conflito de idempotência; mensagem descartada',
          );
          return true;
        }
        if (
          erro instanceof InvalidPayloadError ||
          erro instanceof WalletNotFoundError ||
          erro instanceof InboxPayloadMismatchError
        ) {
          await this.enviarParaDlq(filas, mensagem, erro.code, erro);
          return true;
        }
        const recebimentos = Number(mensagem.Attributes?.ApproximateReceiveCount ?? '1');
        const atraso = Math.min(
          this.env.consumerRetryBaseSeconds * 2 ** (recebimentos - 1),
          ATRASO_MAXIMO_SEGUNDOS,
        );
        await this.devolver(filas, mensagem, atraso);
        this.metrics.increment('wager_retries_total', { component: 'consumer' });
        this.logger.warn(
          { messageId: pedido.messageId, recebimentos, atraso, err: (erro as Error)?.name },
          'consumer: falha transitória; mensagem volta à fila',
        );
        return false;
      }
    });
  }

  private async apagar(queueUrl: string, mensagem: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: mensagem.ReceiptHandle }),
    );
  }

  private async devolver(filas: QueuePair, mensagem: Message, segundos: number): Promise<void> {
    await this.client
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: filas.queueUrl,
          ReceiptHandle: mensagem.ReceiptHandle,
          VisibilityTimeout: segundos,
        }),
      )
      // Se não der para ajustar, a mensagem volta sozinha quando a visibilidade expirar.
      .catch(() => undefined);
  }

  /** Copia a mensagem para a DLQ e só então a apaga da fila principal. */
  private async enviarParaDlq(
    filas: QueuePair,
    mensagem: Message,
    motivo: string,
    erro: unknown,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: filas.dlqUrl,
        MessageBody: mensagem.Body ?? '',
        MessageGroupId: mensagem.Attributes?.MessageGroupId ?? 'sem-grupo',
        MessageDeduplicationId: mensagem.MessageId ?? newCorrelationId(),
        MessageAttributes: {
          motivo: { DataType: 'String', StringValue: motivo },
        },
      }),
    );
    await this.apagar(filas.queueUrl, mensagem);
    this.metrics.increment('wager_dlq_messages_total', { reason: motivo });
    this.logger.error(
      { sqsMessageId: mensagem.MessageId, motivo, detalhe: (erro as Error)?.message },
      'consumer: erro permanente; mensagem enviada à DLQ',
    );
  }
}
