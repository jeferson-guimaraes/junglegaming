import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { type AppProcess, startApp, stopAllApps } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { apagarFila, drenar, enviarCru, esperar, esperarFila, sqsDeTeste } from '../support/sqs';
import { chave, type Linha, transacao } from '../support/test-app';
import { resumoDaWallet, walletsDivergentesDoLedger } from '../support/wallet-assertions';

const sufixo = randomUUID();
const FILAS = {
  SQS_TRANSACTIONS_QUEUE: `tx-multi-${sufixo}.fifo`,
  SQS_TRANSACTIONS_DLQ: `tx-multi-dlq-${sufixo}.fifo`,
  SQS_EVENTS_QUEUE: `ev-multi-${sufixo}.fifo`,
};

let db: TestDatabase;
let sqs: SQSClient;
let env: Record<string, string>;
let apps: AppProcess[] = [];
let filaUrl: string;
let proxima = 0;

type Wallet = { id: string; playerId: string };
type Pedido = ReturnType<typeof transacao>;

const banco = {
  sql: <T = Linha>(texto: string, params: unknown[] = []) =>
    db.orm.em.getConnection().execute<T[]>(texto, params),
};

async function contar(tabela: string, where: string, params: unknown[] = []): Promise<number> {
  const rows = await banco.sql<{ n: string }>(
    `select count(*) as n from ${tabela} where ${where}`,
    params,
  );
  return Number(rows[0]?.n);
}

/** Uma instância completa: API, consumer, publisher da outbox e worker de pendentes. */
const subir = () => startApp(env);

function instancia(): AppProcess {
  const app = apps[proxima % apps.length];
  proxima += 1;
  if (!app) throw new Error('nenhuma instância');
  return app;
}

async function criarWallet(saldo: string): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await fetch(`${instancia().baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: saldo, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, playerId };
}

async function porHttp(pedido: Pedido): Promise<number> {
  const response = await fetch(`${instancia().baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...chave(pedido) },
    body: JSON.stringify(pedido),
  });
  await response.text();
  return response.status;
}

function porFila(pedido: Pedido, messageId = `msg-${randomUUID()}`): Promise<void> {
  const mensagem = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...pedido, idempotencyKey: `${pedido.providerId}:${pedido.externalTransactionId}` },
  };
  return enviarCru(sqs, filaUrl, JSON.stringify(mensagem), pedido.walletId as string);
}

const aposta = (wallet: Wallet) =>
  transacao(wallet, { money: { amount: '10.00', currency: 'BRL' } });

const apostasGravadas = (wallets: Wallet[]) =>
  contar('wager_transactions', "kind = 'BET' and wallet_id in (?)", [wallets.map((w) => w.id)]);

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = sqsDeTeste();
  env = {
    ...FILAS,
    DATABASE_URL: db.url,
    DB_LOCK_TIMEOUT_MS: '15000',
    CONSUMER_ENABLED: 'true',
    CONSUMER_WAIT_TIME_SECONDS: '1',
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '4',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_PUBLISHER_INTERVAL_MS: '100',
    PENDING_WORKER_ENABLED: 'true',
  };
  apps = await Promise.all([subir(), subir(), subir()]);
  filaUrl = await esperarFila(sqs, FILAS.SQS_TRANSACTIONS_QUEUE);
}, 60_000);

afterAll(async () => {
  await stopAllApps();
  await db?.drop();
  for (const fila of Object.values(FILAS)) await apagarFila(sqs, fila);
  sqs?.destroy();
}, 60_000);

describe('3 instâncias completas: HTTP e SQS sobre as mesmas wallets', () => {
  it('HTTP e fila misturados, com repetições nos dois canais: cada aposta é aplicada uma única vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => criarWallet('1000.00')));
    const soHttp = wallets.flatMap((w) => Array.from({ length: 15 }, () => aposta(w)));
    const soFila = wallets.flatMap((w) => Array.from({ length: 15 }, () => aposta(w)));
    const nosDois = wallets.flatMap((w) => Array.from({ length: 10 }, () => aposta(w)));

    const status = await Promise.all([
      ...soHttp.map((p) => porHttp(p)),
      ...nosDois.map((p) => porHttp(p)),
      // A mesma mensagem publicada duas vezes (mesmo messageId).
      ...soFila.flatMap((p) => {
        const messageId = `msg-${randomUUID()}`;
        return [porFila(p, messageId), porFila(p, messageId)];
      }),
      // A mesma transação também pela fila, com a mesma idempotency key do HTTP.
      ...nosDois.map((p) => porFila(p)),
    ]);

    expect(status.filter((s) => typeof s === 'number').every((s) => s === 201)).toBe(true);
    await esperar(
      async () => (await apostasGravadas(wallets)) === 240,
      60_000,
      '240 apostas gravadas',
    );
    // Tempo para as repetições que ainda estão na fila serem tratadas.
    await esperar(async () => (await drenarSemApagar()) === 0, 30_000, 'fila de transações vazia');

    for (const wallet of wallets) {
      expect(await resumoDaWallet(banco, wallet.id)).toMatchObject({
        balance: '600.00',
        version: 41,
        debitos: 40,
        transacoes: 41,
      });
    }
    expect(await walletsDivergentesDoLedger(banco)).toEqual([]);
    expect(
      await drenar(sqs, await esperarFila(sqs, FILAS.SQS_TRANSACTIONS_DLQ), { prazoMs: 1500 }),
    ).toHaveLength(0);
  }, 120_000);

  it('toda a outbox é publicada, e cada evento chega à fila de eventos', async () => {
    await esperar(
      async () => (await contar('outbox_messages', 'published_at is null')) === 0,
      60_000,
      'outbox totalmente publicada',
    );
    const total = await contar('outbox_messages', 'true');

    const eventosUrl = await esperarFila(sqs, FILAS.SQS_EVENTS_QUEUE);
    const recebidos = await drenar(sqs, eventosUrl, { esperadas: total, prazoMs: 90_000 });

    const ids = new Set(recebidos.map((m) => (JSON.parse(m.Body ?? '{}') as Linha).eventId));
    expect(ids.size).toBe(total);
    expect(await contar('outbox_messages', 'id not in (?)', [[...ids]])).toBe(0);
  }, 180_000);
});

describe('Queda e reinício no meio da carga', () => {
  it('uma instância morre (SIGKILL), outra encerra (SIGTERM) e uma nova sobe: nada se perde nem duplica', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => criarWallet('5000.00')));
    const pedidos = wallets.flatMap((w) => Array.from({ length: 60 }, () => aposta(w)));
    await Promise.all(pedidos.map((p) => porFila(p)));
    await esperar(async () => (await apostasGravadas(wallets)) >= 30, 30_000, 'consumo iniciado');

    const [primeira, segunda] = apps;
    if (!primeira || !segunda) throw new Error('instâncias ausentes');
    await primeira.stop('SIGKILL');
    const encerramento = await segunda.stop('SIGTERM');
    expect(encerramento.exitCode).toBe(0);
    apps = [apps[2] as AppProcess, await subir()];

    await esperar(
      async () => (await apostasGravadas(wallets)) === 300,
      120_000,
      '300 apostas gravadas',
    );
    await esperar(
      async () => (await contar('outbox_messages', 'published_at is null')) === 0,
      60_000,
      'outbox totalmente publicada',
    );

    for (const wallet of wallets) {
      expect(await resumoDaWallet(banco, wallet.id)).toMatchObject({
        balance: '4400.00',
        version: 61,
        debitos: 60,
        transacoes: 61,
      });
    }
    expect(await walletsDivergentesDoLedger(banco)).toEqual([]);
  }, 240_000);
});

/** Mensagens ainda na fila de transações (visíveis ou em processamento). */
async function drenarSemApagar(): Promise<number> {
  const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
  const saida = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: filaUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(saida.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(saida.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}
