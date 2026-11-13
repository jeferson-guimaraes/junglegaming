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
  return {
    port: inteiro('PORT', source.PORT, 3000),
    databaseUrl: source.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    dbPoolMax: inteiro('DB_POOL_MAX', source.DB_POOL_MAX, 10),
    dbLockTimeoutMs: inteiro('DB_LOCK_TIMEOUT_MS', source.DB_LOCK_TIMEOUT_MS, 3000),
    sqsEndpoint: source.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: source.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: source.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: source.AWS_SECRET_ACCESS_KEY ?? 'test',
    logLevel: source.LOG_LEVEL ?? 'info',
    pendingWorkerEnabled: booleano('PENDING_WORKER_ENABLED', source.PENDING_WORKER_ENABLED, true),
    pendingWorkerIntervalMs: inteiro(
      'PENDING_WORKER_INTERVAL_MS',
      source.PENDING_WORKER_INTERVAL_MS,
      1000,
    ),
    shutdownTimeoutMs: inteiro('SHUTDOWN_TIMEOUT_MS', source.SHUTDOWN_TIMEOUT_MS, 8000),
  };
}
