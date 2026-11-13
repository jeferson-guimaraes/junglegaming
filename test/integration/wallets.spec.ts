import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { UnitOfWork } from '@/application/ports';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { type FaultyUnitOfWork, faultyUnitOfWorkFactory } from '../support/faulty-unit-of-work';
import { walletsDivergentesDoLedger } from '../support/wallet-assertions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
const anteriores = new Map<string, string | undefined>();

beforeAll(async () => {
  db = await createTestDatabase();
  // Só a API: sem consumer, publisher e worker, o teste não toca as filas reais.
  const variaveis = {
    DATABASE_URL: db.url,
    DB_LOCK_TIMEOUT_MS: '300',
    CONSUMER_ENABLED: 'false',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    PENDING_WORKER_ENABLED: 'false',
  };
  for (const [nome, valor] of Object.entries(variaveis)) {
    anteriores.set(nome, process.env[nome]);
    process.env[nome] = valor;
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  // Invariante final: wallet.balance == saldo reconstruído pelo ledger.
  expect(await walletsDivergentesDoLedger({ sql })).toEqual([]);
  for (const [nome, valor] of anteriores) {
    if (valor === undefined) delete process.env[nome];
    else process.env[nome] = valor;
  }
  await db?.drop();
});

type Linha = Record<string, unknown>;

async function sql<T = Linha>(texto: string, params: unknown[] = []): Promise<T[]> {
  return db.orm.em.getConnection().execute<T[]>(texto, params);
}

async function contar(tabela: string, where = 'true', params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*) as n from ${tabela} where ${where}`,
    params,
  );
  return Number(rows[0]?.n);
}

function postWallet(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const pedido = (amount: string, currency = 'BRL', playerId: string = randomUUID()) => ({
  playerId,
  initialBalance: { amount, currency },
});

describe('POST /wallets', () => {
  it('cria a wallet com saldo inicial e responde 201 no contrato do enunciado', async () => {
    const corpo = pedido('1000.00');

    const response = await postWallet(corpo);
    const wallet = (await response.json()) as Linha;

    expect(response.status).toBe(201);
    expect(wallet).toEqual({
      id: expect.stringMatching(UUID),
      playerId: corpo.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('grava, na mesma operação, a transação OPENING, o lançamento CREDIT e os eventos', async () => {
    const response = await postWallet(pedido('250.50'), { 'x-correlation-id': 'corr-abertura' });
    const { id } = (await response.json()) as { id: string };

    const [wallet] = await sql('select balance, version, currency from wallets where id = ?', [id]);
    expect(wallet).toEqual({ balance: '250.50', version: 1, currency: 'BRL' });

    const transacoes = await sql('select * from wager_transactions where wallet_id = ?', [id]);
    expect(transacoes).toHaveLength(1);
    expect(transacoes[0]).toMatchObject({
      provider_id: 'internal',
      external_transaction_id: id,
      idempotency_key: `opening:${id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '250.50',
      currency: 'BRL',
      round_id: null,
      game_id: null,
      failure_code: null,
      observed_balance: '250.50',
      observed_balance_currency: 'BRL',
    });
    expect(transacoes[0]?.processed_at).not.toBeNull();

    const lancamentos = await sql('select * from wallet_ledger_entries where wallet_id = ?', [id]);
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]).toMatchObject({
      transaction_id: transacoes[0]?.id,
      direction: 'CREDIT',
      amount: '250.50',
      currency: 'BRL',
      balance_before: '0.00',
      balance_after: '250.50',
    });

    const eventos = await sql<Linha & { event_type: string; payload: Linha }>(
      'select event_type, payload, attempts, occurred_at, next_attempt_at, published_at from outbox_messages where aggregate_id = ?',
      [id],
    );
    expect(eventos.map((e) => e.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const evento of eventos) {
      expect(evento).toMatchObject({ attempts: 0, published_at: null });
      expect(evento.payload).toMatchObject({
        eventType: evento.event_type,
        occurredAt: new Date(evento.occurred_at as string).toISOString(),
        aggregateId: id,
        correlationId: 'corr-abertura',
        version: 1,
      });
    }
    const saldoMudou = eventos.find((e) => e.event_type === 'WalletBalanceChanged');
    expect(saldoMudou?.payload.data).toMatchObject({
      walletId: id,
      direction: 'CREDIT',
      money: { amount: '250.50', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '250.50', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('saldo inicial zero cria a wallet sem OPENING, sem lançamento e sem evento', async () => {
    const response = await postWallet(pedido('0.00'));
    const wallet = (await response.json()) as { id: string; version: number; balance: Linha };

    expect(response.status).toBe(201);
    expect(wallet.version).toBe(1);
    expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(
      await contar('wallets', "id = ? and balance = '0.00' and version = 1", [wallet.id]),
    ).toBe(1);
    expect(await contar('wager_transactions', 'wallet_id = ?', [wallet.id])).toBe(0);
    expect(await contar('wallet_ledger_entries', 'wallet_id = ?', [wallet.id])).toBe(0);
    expect(await contar('outbox_messages', 'aggregate_id = ?', [wallet.id])).toBe(0);
  });

  it('wallet duplicada para o mesmo player e moeda é conflito (409) e nada é gravado', async () => {
    const corpo = pedido('10.00');
    await postWallet(corpo);

    const response = await postWallet(corpo);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    expect(await contar('wallets', 'player_id = ?', [corpo.playerId])).toBe(1);
    expect(await contar('wager_transactions', 'player_id = ?', [corpo.playerId])).toBe(1);
  });

  it('playerId em maiúsculas é a mesma wallet: a resposta e a duplicata usam minúsculas', async () => {
    const playerId = randomUUID();

    const primeira = await postWallet(pedido('10.00', 'BRL', playerId.toUpperCase()));

    expect(primeira.status).toBe(201);
    expect(((await primeira.json()) as { playerId: string }).playerId).toBe(playerId);
    expect((await postWallet(pedido('10.00', 'BRL', playerId))).status).toBe(409);
  });

  it('o mesmo player pode ter wallet em outra moeda', async () => {
    const playerId = randomUUID();
    await postWallet(pedido('10.00', 'BRL', playerId));

    const response = await postWallet(pedido('10.00', 'USD', playerId));

    expect(response.status).toBe(201);
  });

  it('criações simultâneas para o mesmo player: uma vence, as outras recebem 409', async () => {
    const corpo = pedido('100.00');

    const respostas = await Promise.all(Array.from({ length: 8 }, () => postWallet(corpo)));

    const status = respostas.map((r) => r.status).sort();
    expect(status).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(await contar('wallets', 'player_id = ?', [corpo.playerId])).toBe(1);
    expect(await contar('wager_transactions', 'player_id = ?', [corpo.playerId])).toBe(1);
    const [wallet] = await sql<{ id: string }>('select id from wallets where player_id = ?', [
      corpo.playerId,
    ]);
    expect(await contar('wallet_ledger_entries', 'wallet_id = ?', [wallet?.id])).toBe(1);
    expect(await contar('outbox_messages', 'aggregate_id = ?', [wallet?.id])).toBe(2);
  });

  it.each([
    ['corpo que não é JSON', '{isto não é json'],
    ['corpo que não é objeto', [1, 2]],
    ['playerId ausente', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['playerId que não é UUID', pedido('1.00', 'BRL', 'player-1')],
    ['playerId que não é string', { ...pedido('1.00'), playerId: 123 }],
    ['initialBalance ausente', { playerId: randomUUID() }],
    ['valor com mais de 2 casas', pedido('1.001')],
    ['valor sem casas decimais', pedido('1000')],
    ['valor com 1 casa', pedido('10.5')],
    ['valor negativo', pedido('-1.00')],
    [
      'valor numérico em vez de string',
      { ...pedido('1.00'), initialBalance: { amount: 1, currency: 'BRL' } },
    ],
    ['moeda em minúsculas', pedido('1.00', 'brl')],
    ['moeda ausente', { playerId: randomUUID(), initialBalance: { amount: '1.00' } }],
  ])('payload inválido (%s) responde 400 e não grava nada', async (_caso, corpo) => {
    const antes = await contar('wallets');

    const response = await postWallet(corpo);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'INVALID_PAYLOAD',
      message: expect.any(String),
    });
    expect(await contar('wallets')).toBe(antes);
  });

  it('devolve o correlationId no cabeçalho da resposta', async () => {
    const response = await postWallet(pedido('1.00'), { 'x-correlation-id': 'corr-xyz' });

    expect(response.headers.get('x-correlation-id')).toBe('corr-xyz');
  });
});

describe('POST /wallets: atomicidade e falha transitória', () => {
  it('falha ao gravar o segundo evento desfaz wallet, transação, lançamento e o primeiro evento', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UnitOfWork)
      .useFactory(faultyUnitOfWorkFactory(2))
      .compile();
    const appComFalha = moduleRef.createNestApplication({ logger: false });
    await appComFalha.listen(0);
    const corpo = pedido('75.00');
    const eventosAntes = await contar('outbox_messages');

    try {
      const response = await fetch(`${await appComFalha.getUrl()}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
      // A falha veio depois de a wallet, a transação, o lançamento e um evento já terem sido gravados.
      expect(appComFalha.get<FaultyUnitOfWork>(UnitOfWork).tentativasNoOutbox).toBe(2);
      expect(await contar('wallets', 'player_id = ?', [corpo.playerId])).toBe(0);
      expect(await contar('wager_transactions', 'player_id = ?', [corpo.playerId])).toBe(0);
      expect(await contar('wallet_ledger_entries', "amount = '75.00'")).toBe(0);
      expect(await contar('outbox_messages')).toBe(eventosAntes);
    } finally {
      await appComFalha.close();
    }
  });

  it('espera por lock além do prazo responde 503 com Retry-After, e a criação pode ser reenviada', async () => {
    const corpo = pedido('30.00');
    // Outra transação, ainda aberta, já inseriu a wallet do mesmo player: a criação fica esperando.
    const concorrente = db.orm.em.fork();
    await concorrente.begin();
    try {
      await concorrente.getConnection().execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', '0.00', 1, now(), now())`,
        [randomUUID(), corpo.playerId],
        'run',
        concorrente.getTransactionContext(),
      );

      const response = await postWallet(corpo);

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toMatchObject({ code: 'TRANSIENT_FAILURE' });
    } finally {
      await concorrente.rollback();
    }

    expect((await postWallet(corpo)).status).toBe(201);
    expect(await contar('wallets', 'player_id = ?', [corpo.playerId])).toBe(1);
  });
});

describe('GET /wallets/:walletId', () => {
  it('devolve a wallet no mesmo contrato da criação', async () => {
    const criada = (await (await postWallet(pedido('42.10'))).json()) as { id: string };

    const response = await fetch(`${baseUrl}/wallets/${criada.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(criada);
  });

  it('wallet inexistente responde 404', async () => {
    const response = await fetch(`${baseUrl}/wallets/${randomUUID()}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('id que não é UUID responde 400, sem chegar ao banco', async () => {
    const response = await fetch(`${baseUrl}/wallets/nao-e-uuid`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});
