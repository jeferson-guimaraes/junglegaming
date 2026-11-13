import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startApp, stopAllApps } from '../support/app-process';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ DB_LOCK_TIMEOUT_MS: '300' });
});

afterAll(async () => {
  await t?.close();
});

afterEach(async () => {
  await stopAllApps();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function metricas(baseUrl = t.baseUrl): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

function valor(texto: string, serie: string): number | undefined {
  const linha = texto.split('\n').find((l) => l.startsWith(`${serie} `));
  return linha === undefined ? undefined : Number(linha.slice(serie.length + 1));
}

describe('GET /metrics', () => {
  it('conta transações por status, duplicatas, conflitos de lock e mede a latência', async () => {
    const wallet = await t.criarWallet('100.00');
    const processada = transacao(wallet);
    const rejeitada = transacao(wallet, { money: brl('500.00') });
    await t.postTransacao(processada, chave(processada));
    await t.postTransacao(rejeitada, chave(rejeitada));
    await t.postTransacao(processada, chave(processada)); // replay
    await t.postTransacao({ ...processada, money: brl('1.00') }, chave(processada)); // conflito
    // Falha transitória: a wallet está travada por outra transação além do prazo.
    const dono = t.db.orm.em.fork();
    await dono.begin();
    try {
      await dono
        .getConnection()
        .execute(
          'select id from wallets where id = ? for update',
          [wallet.id],
          'all',
          dono.getTransactionContext(),
        );
      const presa = transacao(wallet);
      expect((await t.postTransacao(presa, chave(presa))).status).toBe(503);
    } finally {
      await dono.rollback();
    }

    const texto = await metricas();

    expect(
      valor(texto, 'wager_transactions_total{kind="BET",source="http",status="PROCESSED"}'),
    ).toBe(1);
    expect(
      valor(texto, 'wager_transactions_total{kind="BET",source="http",status="REJECTED"}'),
    ).toBe(1);
    expect(valor(texto, 'wager_duplicates_total{type="idempotent_replay"}')).toBe(1);
    expect(valor(texto, 'wager_duplicates_total{type="idempotency_conflict"}')).toBe(1);
    expect(valor(texto, 'wager_lock_conflicts_total{reason="55P03"}')).toBe(1);
    expect(valor(texto, 'wager_processing_duration_seconds_count{source="http"}')).toBe(5);
    expect(valor(texto, 'wager_processing_duration_seconds_sum{source="http"}')).toBeGreaterThan(0);
    expect(texto).toContain('# TYPE wager_processing_duration_seconds histogram');
  });

  it('mostra quantos eventos da outbox estão pendentes e a idade do mais antigo', async () => {
    await t.sql(
      'update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null',
    );
    expect(valor(await metricas(), 'wager_outbox_pending')).toBe(0);
    expect(valor(await metricas(), 'wager_outbox_lag_seconds')).toBe(0);

    await t.criarWallet('10.00'); // 2 eventos; o publisher está desligado neste teste
    await t.sql(
      "update outbox_messages set occurred_at = now() - interval '90 seconds' where published_at is null",
    );

    const texto = await metricas();
    expect(valor(texto, 'wager_outbox_pending')).toBe(2);
    expect(valor(texto, 'wager_outbox_lag_seconds')).toBeGreaterThanOrEqual(90);
    expect(valor(texto, 'wager_outbox_lag_seconds')).toBeLessThan(120);
  });
});

describe('GET /health/ready', () => {
  it('200 com PostgreSQL e SQS alcançáveis, sem exigir autenticação', async () => {
    const response = await fetch(`${t.baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  it.each([
    ['SQS', { SQS_ENDPOINT: 'http://127.0.0.1:1' }, { postgres: 'up', sqs: 'down' }],
    [
      'PostgreSQL',
      { DATABASE_URL: 'postgres://wagering:wagering@127.0.0.1:1/wagering' },
      { postgres: 'down', sqs: 'up' },
    ],
  ])(
    '503 quando o %s está fora, dizendo qual dependência falhou; a liveness continua 200',
    async (_caso, env, checks) => {
      const app = await startApp(env);

      const pronta = await fetch(`${app.baseUrl}/health/ready`);
      const viva = await fetch(`${app.baseUrl}/health/live`);

      expect(pronta.status).toBe(503);
      expect(await pronta.json()).toEqual({ status: 'unavailable', checks });
      expect(viva.status).toBe(200);
    },
    20_000,
  );
});

describe('Logs', () => {
  it('são JSON com correlationId, transactionId, walletId e providerId, e sem valores monetários nem payload', async () => {
    const app = await startApp({ DATABASE_URL: t.db.url });
    const playerId = randomUUID();
    const criacao = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('7777.77') }),
    });
    const wallet = { id: ((await criacao.json()) as { id: string }).id, playerId };
    const processada = transacao(wallet, { money: brl('1234.56'), roundId: 'rodada-secreta' });
    const rejeitada = transacao(wallet, { money: brl('99999.99') });
    for (const pedido of [processada, rejeitada]) {
      await fetch(`${app.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': 'corr-log',
          ...chave(pedido),
        },
        body: JSON.stringify(pedido),
      });
    }
    // Divergência provocada: a reconciliação loga o problema, e esse log também não leva valores.
    await t.sql("update wallets set balance = '1111.11' where id = ?", [wallet.id]);
    t.divergenciaProvocada(wallet.id);
    await fetch(`${app.baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });

    const { logs } = await app.stop('SIGTERM');

    const doProcessamento = logs.filter((l) => l.msg === 'transação processada') as Linha[];
    expect(doProcessamento).toHaveLength(2);
    expect(doProcessamento[0]).toMatchObject({
      level: 'info',
      correlationId: 'corr-log',
      transactionId: expect.any(String),
      walletId: wallet.id,
      providerId: 'provider-a',
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
      pid: app.pid,
      time: expect.any(String),
    });
    expect(doProcessamento[1]).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });

    expect(
      logs.find((l) => l.msg === 'reconciliação: saldo da wallet diverge do ledger'),
    ).toMatchObject({
      level: 'error',
      walletId: wallet.id,
      checkedEntries: 2,
    });

    const tudo = logs.map((l) => JSON.stringify(l)).join('\n');
    for (const sensivel of [
      '7777.77',
      '1234.56',
      '99999.99',
      '6543.21',
      '1111.11',
      'rodada-secreta',
      'amount',
      'money',
    ]) {
      expect(tudo).not.toContain(sensivel);
    }
  }, 20_000);
});
