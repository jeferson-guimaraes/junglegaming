import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { createTestDatabase, type TestDatabase } from './database';
import { walletsDivergentesDoLedger } from './wallet-assertions';

export type Linha = Record<string, unknown>;

export interface TestApp {
  db: TestDatabase;
  app: INestApplication;
  baseUrl: string;
  sql<T = Linha>(texto: string, params?: unknown[]): Promise<T[]>;
  contar(tabela: string, where?: string, params?: unknown[]): Promise<number>;
  /** Sobe outra aplicação Nest no mesmo banco, com providers sobrescritos. */
  variante(configurar: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<{
    app: INestApplication;
    baseUrl: string;
  }>;
  criarWallet(saldo: string, currency?: string): Promise<{ id: string; playerId: string }>;
  /** Avisa que o teste adulterou o saldo desta wallet de propósito (ex.: reconciliação). */
  divergenciaProvocada(walletId: string): void;
  postTransacao(
    body: unknown,
    headers?: Record<string, string>,
    baseUrl?: string,
  ): Promise<Response>;
  close(): Promise<void>;
}

/** Aplicação Nest em memória (HTTP real em porta efêmera) sobre um banco exclusivo do arquivo. */
export async function startTestApp(
  env: Record<string, string> = {},
  configurarPrincipal: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const db = await createTestDatabase();
  // Os workers ficam desligados: cada teste dispara os ciclos na hora que quiser.
  const variaveis = {
    DATABASE_URL: db.url,
    PENDING_WORKER_ENABLED: 'false',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    CONSUMER_ENABLED: 'false',
    ...env,
  };
  const anteriores = new Map<string, string | undefined>();
  for (const [nome, valor] of Object.entries(variaveis)) {
    anteriores.set(nome, process.env[nome]);
    process.env[nome] = valor;
  }

  const apps: INestApplication[] = [];
  async function subir(
    configurar: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
  ): Promise<{ app: INestApplication; baseUrl: string }> {
    const moduleRef = await configurar(
      Test.createTestingModule({ imports: [AppModule] }),
    ).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    apps.push(app);
    return { app, baseUrl: await app.getUrl() };
  }

  const principal = await subir(configurarPrincipal);
  const adulteradas = new Set<string>();
  const sql = <T = Linha>(texto: string, params: unknown[] = []) =>
    db.orm.em.getConnection().execute<T[]>(texto, params);

  return {
    db,
    ...principal,
    sql,
    variante: subir,
    async contar(tabela, where = 'true', params = []) {
      const rows = await sql<{ n: string }>(
        `select count(*) as n from ${tabela} where ${where}`,
        params,
      );
      return Number(rows[0]?.n);
    },
    async criarWallet(saldo, currency = 'BRL') {
      const playerId = randomUUID();
      const response = await fetch(`${principal.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: saldo, currency } }),
      });
      if (response.status !== 201) throw new Error(`criação de wallet falhou: ${response.status}`);
      const { id } = (await response.json()) as { id: string };
      return { id, playerId };
    },
    postTransacao(body, headers = {}, baseUrl = principal.baseUrl) {
      return fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    },
    divergenciaProvocada(walletId) {
      adulteradas.add(walletId);
    },
    async close() {
      await Promise.all(apps.map((app) => app.close()));
      // Invariante final de todo arquivo de teste: wallet.balance == saldo reconstruído pelo ledger.
      const divergentes = (await walletsDivergentesDoLedger({ sql }).catch(() => [])).filter(
        (wallet) => !adulteradas.has(wallet.id),
      );
      for (const [nome, valor] of anteriores) {
        if (valor === undefined) delete process.env[nome];
        else process.env[nome] = valor;
      }
      await db.drop();
      if (divergentes.length > 0) {
        throw new Error(
          `Invariante violada: saldo diferente do ledger em ${JSON.stringify(divergentes)}`,
        );
      }
    },
  };
}

let sequencia = 0;

/** Corpo de uma transação válida, com identificador externo novo a cada chamada. */
export function transacao(
  wallet: { id: string; playerId: string },
  overrides: Linha = {},
): Linha & { providerId: string; externalTransactionId: string } {
  sequencia += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequencia}-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  } as Linha & { providerId: string; externalTransactionId: string };
}

/** Chave de idempotência no formato recomendado pelo enunciado. */
export function chave(body: {
  providerId: string;
  externalTransactionId: string;
}): Record<string, string> {
  return { 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` };
}
