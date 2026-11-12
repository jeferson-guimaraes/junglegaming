export interface Env {
  port: number;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  logLevel: string;
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

/** Lê a configuração do ambiente. Os padrões apontam para o docker-compose local. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return {
    port: inteiro('PORT', source.PORT, 3000),
    databaseUrl: source.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    sqsEndpoint: source.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: source.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: source.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: source.AWS_SECRET_ACCESS_KEY ?? 'test',
    logLevel: source.LOG_LEVEL ?? 'info',
    shutdownTimeoutMs: inteiro('SHUTDOWN_TIMEOUT_MS', source.SHUTDOWN_TIMEOUT_MS, 8000),
  };
}
