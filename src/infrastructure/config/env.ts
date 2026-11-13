import { QUEUES, WAGER_TRANSACTIONS_MAX_RECEIVE_COUNT } from '../sqs/queue-names';

export interface Env {
  port: number;
  databaseUrl: string;
  /** Máximo de conexões do pool por instância. */
  dbPoolMax: number;
  /** Prazo de espera por lock de linha; estourado, a operação falha como erro transitório. */
  dbLockTimeoutMs: number;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  logLevel: string;
  /** Fila FIFO de entrada das transações e a DLQ dela. */
  transactionsQueueName: string;
  transactionsDlqName: string;
  /** Liga o consumer da fila de transações. */
  consumerEnabled: boolean;
  /** Tempo, em segundos, que uma mensagem recebida fica invisível para os outros consumers. */
  consumerVisibilityTimeoutSeconds: number;
  /** Long polling do recebimento, em segundos. */
  consumerWaitTimeSeconds: number;
  /** Base, em segundos, do intervalo crescente antes de reentregar após falha transitória. */
  consumerRetryBaseSeconds: number;
  /** Recebimentos de uma mensagem antes de o broker movê-la para a DLQ. */
  consumerMaxReceiveCount: number;
  /** Só para teste de falha: encerra o processo depois do commit e antes do ack. */
  faultExitBeforeAck: boolean;
  /** Fila FIFO que recebe os eventos de integração. */
  eventsQueueName: string;
  /** Liga o publisher do outbox. */
  outboxPublisherEnabled: boolean;
  /** Intervalo entre os ciclos do publisher do outbox. */
  outboxPublisherIntervalMs: number;
  /** Liga o worker que reprocessa transações à espera de referência. */
  pendingWorkerEnabled: boolean;
  /** Intervalo entre os ciclos do worker de pendentes. */
  pendingWorkerIntervalMs: number;
  /** Prazo máximo do encerramento; deve ficar abaixo do tempo de espera do orquestrador (10 s no Docker). */
  shutdownTimeoutMs: number;
}

function inteiro(nome: string, valor: string | undefined, padrao: number): number {
  if (valor === undefined || valor === '') return padrao;
  const numero = Number(valor);
  if (!Number.isInteger(numero)) {
    throw new Error(`Variável de ambiente ${nome} deve ser um inteiro, recebido "${valor}"`);
  }
  return numero;
}

function booleano(nome: string, valor: string | undefined, padrao: boolean): boolean {
  if (valor === undefined || valor === '') return padrao;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  throw new Error(`Variável de ambiente ${nome} deve ser "true" ou "false", recebido "${valor}"`);
}

/** Lê a configuração do ambiente. Os padrões apontam para o docker-compose local. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source.NODE_ENV === 'production' && source.FAULT_EXIT_BEFORE_ACK === 'true') {
    throw new Error('FAULT_EXIT_BEFORE_ACK é só para teste e não pode ser ligada em produção');
  }
  return {
    port: inteiro('PORT', source.PORT, 3000),
    databaseUrl: source.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    dbPoolMax: inteiro('DB_POOL_MAX', source.DB_POOL_MAX, 20),
    dbLockTimeoutMs: inteiro('DB_LOCK_TIMEOUT_MS', source.DB_LOCK_TIMEOUT_MS, 3000),
    sqsEndpoint: source.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: source.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: source.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: source.AWS_SECRET_ACCESS_KEY ?? 'test',
    logLevel: source.LOG_LEVEL ?? 'info',
    transactionsQueueName: source.SQS_TRANSACTIONS_QUEUE ?? QUEUES.wagerTransactions,
    transactionsDlqName: source.SQS_TRANSACTIONS_DLQ ?? QUEUES.wagerTransactionsDlq,
    consumerEnabled: booleano('CONSUMER_ENABLED', source.CONSUMER_ENABLED, true),
    consumerVisibilityTimeoutSeconds: inteiro(
      'CONSUMER_VISIBILITY_TIMEOUT_SECONDS',
      source.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
      30,
    ),
    consumerWaitTimeSeconds: inteiro(
      'CONSUMER_WAIT_TIME_SECONDS',
      source.CONSUMER_WAIT_TIME_SECONDS,
      2,
    ),
    consumerRetryBaseSeconds: inteiro(
      'CONSUMER_RETRY_BASE_SECONDS',
      source.CONSUMER_RETRY_BASE_SECONDS,
      2,
    ),
    consumerMaxReceiveCount: inteiro(
      'CONSUMER_MAX_RECEIVE_COUNT',
      source.CONSUMER_MAX_RECEIVE_COUNT,
      WAGER_TRANSACTIONS_MAX_RECEIVE_COUNT,
    ),
    faultExitBeforeAck: booleano('FAULT_EXIT_BEFORE_ACK', source.FAULT_EXIT_BEFORE_ACK, false),
    eventsQueueName: source.SQS_EVENTS_QUEUE ?? QUEUES.wagerEvents,
    outboxPublisherEnabled: booleano(
      'OUTBOX_PUBLISHER_ENABLED',
      source.OUTBOX_PUBLISHER_ENABLED,
      true,
    ),
    outboxPublisherIntervalMs: inteiro(
      'OUTBOX_PUBLISHER_INTERVAL_MS',
      source.OUTBOX_PUBLISHER_INTERVAL_MS,
      500,
    ),
    pendingWorkerEnabled: booleano('PENDING_WORKER_ENABLED', source.PENDING_WORKER_ENABLED, true),
    pendingWorkerIntervalMs: inteiro(
      'PENDING_WORKER_INTERVAL_MS',
      source.PENDING_WORKER_INTERVAL_MS,
      1000,
    ),
    shutdownTimeoutMs: inteiro('SHUTDOWN_TIMEOUT_MS', source.SHUTDOWN_TIMEOUT_MS, 8000),
  };
}
