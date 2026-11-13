import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConcurrentUpdateError, TransientInfrastructureError } from '@/application/errors';
import { UnitOfWork } from '@/application/ports';
import { Money } from '@/domain/money';
import { computePayloadHash } from '@/domain/payload-hash';
import { type FaultyUnitOfWork, faultyUnitOfWorkFactory } from '../support/faulty-unit-of-work';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ DB_LOCK_TIMEOUT_MS: '300' });
});

afterAll(async () => {
  await t?.close();
});

interface Resposta {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

async function enviar(body: Parameters<typeof chave>[0] & Linha, headers = chave(body)) {
  const response = await t.postTransacao(body, headers);
  return { status: response.status, body: (await response.json()) as Resposta & Linha, response };
}

async function saldo(walletId: string): Promise<{ balance: string; version: number }> {
  const [linha] = await t.sql<{ balance: string; version: number }>(
    'select balance, version from wallets where id = ?',
    [walletId],
  );
  if (!linha) throw new Error('wallet não encontrada');
  return linha;
}

const eventosDe = async (walletId: string, transactionId: string) =>
  (
    await t.sql<{ event_type: string; payload: { data: Linha } & Linha }>(
      "select event_type, payload from outbox_messages where aggregate_id = ? and payload->'data'->>'transactionId' = ? order by event_type",
      [walletId, transactionId],
    )
  ).map((e) => ({ tipo: e.event_type, payload: e.payload }));

describe('POST /wagering/transactions: BET', () => {
  it('processada: 201 no contrato do enunciado, com o saldo depois do débito', async () => {
    const wallet = await t.criarWallet('1000.00');

    const { status, body } = await enviar(transacao(wallet));

    expect(status).toBe(201);
    expect(body).toEqual({
      transactionId: expect.stringMatching(UUID),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('grava transação, saldo, versão, lançamento e eventos na mesma operação', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const { body } = await enviar(pedido, {
      ...chave(pedido),
      'x-correlation-id': 'corr-bet',
    });

    expect(await saldo(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    const [tx] = await t.sql('select * from wager_transactions where id = ?', [body.transactionId]);
    expect(tx).toMatchObject({
      provider_id: 'provider-a',
      external_transaction_id: pedido.externalTransactionId,
      idempotency_key: `provider-a:${pedido.externalTransactionId}`,
      payload_hash: computePayloadHash(pedido as never),
      wallet_id: wallet.id,
      player_id: wallet.playerId,
      round_id: 'round-1',
      game_id: 'fortune-chimp',
      kind: 'BET',
      amount: '80.00',
      currency: 'BRL',
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '20.00',
      observed_balance_currency: 'BRL',
    });
    const lancamentos = await t.sql(
      'select * from wallet_ledger_entries where transaction_id = ?',
      [body.transactionId],
    );
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]).toMatchObject({
      wallet_id: wallet.id,
      direction: 'DEBIT',
      amount: '80.00',
      balance_before: '100.00',
      balance_after: '20.00',
    });
    const eventos = await eventosDe(wallet.id, body.transactionId);
    expect(eventos.map((e) => e.tipo)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const evento of eventos) {
      expect(evento.payload).toMatchObject({ aggregateId: wallet.id, correlationId: 'corr-bet' });
    }
    expect(eventos[1]?.payload.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '20.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('sem saldo: 422 com INSUFFICIENT_FUNDS, transação REJECTED auditável, sem lançamento', async () => {
    const wallet = await t.criarWallet('10.00');

    const { status, body } = await enviar(transacao(wallet));

    expect(status).toBe(422);
    expect(body).toEqual({
      transactionId: expect.stringMatching(UUID),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await saldo(wallet.id)).toEqual({ balance: '10.00', version: 1 });
    expect(
      await t.contar('wallet_ledger_entries', 'transaction_id = ?', [body.transactionId]),
    ).toBe(0);
    const eventos = await eventosDe(wallet.id, body.transactionId);
    expect(eventos.map((e) => e.tipo)).toEqual(['WagerTransactionRejected']);
    expect(eventos[0]?.payload.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });
  });

  it('aposta do saldo inteiro é aceita e zera a wallet', async () => {
    const wallet = await t.criarWallet('25.00');

    const { status, body } = await enviar(transacao(wallet));

    expect(status).toBe(201);
    expect(body.balance.amount).toBe('0.00');
  });
});

describe('POST /wagering/transactions: WIN e LOSS', () => {
  it('WIN credita o saldo com um lançamento CREDIT', async () => {
    const wallet = await t.criarWallet('20.00');

    const { status, body } = await enviar(
      transacao(wallet, { kind: 'WIN', money: { amount: '150.00', currency: 'BRL' } }),
    );

    expect(status).toBe(201);
    expect(body.balance.amount).toBe('170.00');
    expect(await saldo(wallet.id)).toEqual({ balance: '170.00', version: 2 });
    const [lancamento] = await t.sql(
      'select direction, amount from wallet_ledger_entries where transaction_id = ?',
      [body.transactionId],
    );
    expect(lancamento).toEqual({ direction: 'CREDIT', amount: '150.00' });
  });

  it('WIN que referencia uma BET processada guarda a referência resolvida', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = transacao(wallet);
    const { body: aposta } = await enviar(bet);

    const { status, body } = await enviar(
      transacao(wallet, {
        kind: 'WIN',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(status).toBe(201);
    const [tx] = await t.sql(
      'select reference_transaction_id from wager_transactions where id = ?',
      [body.transactionId],
    );
    expect(tx?.reference_transaction_id).toBe(aposta.transactionId);
  });

  it('LOSS é processada sem mover saldo, sem lançamento e sem WalletBalanceChanged', async () => {
    const wallet = await t.criarWallet('20.00');

    const { status, body } = await enviar(
      transacao(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
    );

    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' } });
    expect(await saldo(wallet.id)).toEqual({ balance: '20.00', version: 1 });
    expect(
      await t.contar('wallet_ledger_entries', 'transaction_id = ?', [body.transactionId]),
    ).toBe(0);
    expect((await eventosDe(wallet.id, body.transactionId)).map((e) => e.tipo)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });
});

describe('POST /wagering/transactions: validações contra a wallet', () => {
  it('wallet inexistente: 404 e nenhuma transação gravada', async () => {
    const fantasma = { id: randomUUID(), playerId: randomUUID() };
    const pedido = transacao(fantasma);

    const { status, body } = await enviar(pedido);

    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(
      await t.contar('wager_transactions', 'external_transaction_id = ?', [
        pedido.externalTransactionId,
      ]),
    ).toBe(0);
  });

  it('player que não é dono da wallet: 422 WALLET_PLAYER_MISMATCH, auditável', async () => {
    const wallet = await t.criarWallet('100.00');

    const { status, body } = await enviar(transacao(wallet, { playerId: randomUUID() }));

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });

  it('moeda diferente da wallet: 422 CURRENCY_MISMATCH, com o saldo na moeda da wallet', async () => {
    const wallet = await t.criarWallet('100.00');

    const { status, body } = await enviar(
      transacao(wallet, { money: { amount: '10.00', currency: 'USD' } }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });
});

describe('POST /wagering/transactions: idempotência', () => {
  it('requisição idêntica devolve a mesma resposta com idempotentReplay e não repete o débito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);

    const primeira = await enviar(pedido);
    const segunda = await enviar(pedido);

    expect(segunda.status).toBe(201);
    expect(segunda.body).toEqual({ ...primeira.body, idempotentReplay: true });
    expect(await saldo(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(
      await t.contar('wallet_ledger_entries', 'wallet_id = ? and direction = ?', [
        wallet.id,
        'DEBIT',
      ]),
    ).toBe(1);
    expect((await eventosDe(wallet.id, primeira.body.transactionId)).length).toBe(2);
  });

  it('o replay devolve o saldo observado na hora, mesmo depois de outras transações', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await enviar(pedido);
    await enviar(transacao(wallet));
    await enviar(transacao(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));

    const replay = await enviar(pedido);

    expect(replay.body).toMatchObject({
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect((await saldo(wallet.id)).balance).toBe('550.00');
  });

  it('replay de rejeição repete o 422, não vira sucesso mesmo que agora haja saldo', async () => {
    const wallet = await t.criarWallet('10.00');
    const pedido = transacao(wallet);
    const primeira = await enviar(pedido);
    await enviar(transacao(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));

    const replay = await enviar(pedido);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...primeira.body, idempotentReplay: true });
    expect((await saldo(wallet.id)).balance).toBe('510.00');
  });

  it('replay reconhece o mesmo payload com chaves em outra ordem e ids em maiúsculas', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await enviar(pedido);
    const reordenado = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: pedido.kind,
      gameId: pedido.gameId,
      roundId: pedido.roundId,
      walletId: wallet.id.toUpperCase(),
      playerId: wallet.playerId.toUpperCase(),
      externalTransactionId: pedido.externalTransactionId,
      providerId: pedido.providerId,
    };

    const replay = await enviar(reordenado, chave(pedido));

    expect(replay.status).toBe(201);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['rodada', { roundId: 'round-2' }],
    ['tipo', { kind: 'WIN' }],
  ])('mesma chave com outro payload (%s) é conflito 409, não replay', async (_campo, diferenca) => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await enviar(pedido);

    const { status, body } = await enviar({ ...pedido, ...diferenca }, chave(pedido));

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await saldo(wallet.id)).toEqual({ balance: '75.00', version: 2 });
  });

  it('mesmo par provider/externalTransactionId sob outra chave é conflito 409', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await enviar(pedido);

    const { status, body } = await enviar(pedido, { 'idempotency-key': 'outra-chave' });

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await saldo(wallet.id)).toEqual({ balance: '75.00', version: 2 });
  });

  it('chave no formato interno de abertura encontra a OPENING e dá conflito, nunca replay', async () => {
    const wallet = await t.criarWallet('100.00');

    const { status } = await enviar(transacao(wallet), {
      'idempotency-key': `opening:${wallet.id}`,
    });

    expect(status).toBe(409);
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });

  it('a mesma chave em corrida para wallets diferentes: uma processa, as outras 409, nenhuma 500', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => t.criarWallet('100.00')));
    const headers = { 'idempotency-key': `corrida-${randomUUID()}` };

    const respostas = await Promise.all(
      wallets.map((wallet) => enviar(transacao(wallet), headers)),
    );

    const status = respostas.map((r) => r.status).sort();
    expect(status).toEqual([201, 409, 409, 409, 409, 409]);
    expect(
      await t.contar('wager_transactions', 'idempotency_key = ?', [headers['idempotency-key']]),
    ).toBe(1);
    const saldos = await Promise.all(wallets.map((w) => saldo(w.id)));
    expect(saldos.filter((s) => s.balance === '75.00')).toHaveLength(1);
    expect(saldos.filter((s) => s.balance === '100.00')).toHaveLength(5);
  });
});

describe('POST /wagering/transactions: corrida do mesmo id externo com chaves diferentes', () => {
  it('em wallets diferentes: uma processa, as outras recebem 409, nenhuma 500', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => t.criarWallet('100.00')));
    const externalTransactionId = `ext-corrida-${randomUUID()}`;

    const respostas = await Promise.all(
      wallets.map((wallet, i) =>
        enviar(transacao(wallet, { externalTransactionId }), {
          'idempotency-key': `k${i}-${randomUUID()}`,
        }),
      ),
    );

    expect(respostas.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(
      await t.contar('wager_transactions', 'external_transaction_id = ?', [externalTransactionId]),
    ).toBe(1);
  });
});

describe('Update da wallet condicionado à versão', () => {
  it('gravar com uma versão que não é mais a do banco falha como erro transitório e não altera o saldo', async () => {
    const wallet = await t.criarWallet('100.00');
    const uow = t.app.get(UnitOfWork);

    const tentativa = uow.run(async ({ wallets }) => {
      const carregada = await wallets.findByIdForUpdate(wallet.id);
      if (!carregada) throw new Error('wallet não encontrada');
      carregada.credit({
        money: Money.from({ amount: '50.00', currency: 'BRL' }),
        transactionId: randomUUID(),
        entryId: randomUUID(),
        now: new Date(),
      });
      await wallets.update(carregada, 7); // a versão no banco é 1
    });

    await expect(tentativa).rejects.toBeInstanceOf(ConcurrentUpdateError);
    await expect(tentativa).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('POST /wagering/transactions: payload inválido', () => {
  it('sem o cabeçalho Idempotency-Key: 400', async () => {
    const wallet = await t.criarWallet('100.00');

    const { status, body } = await enviar(transacao(wallet), {});

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it.each([
    ['kind desconhecido', { kind: 'BONUS' }],
    ['kind interno OPENING', { kind: 'OPENING' }],
    ['providerId reservado', { providerId: 'internal' }],
    ['providerId vazio', { providerId: '' }],
    ['externalTransactionId ausente', { externalTransactionId: undefined }],
    ['externalTransactionId longo demais', { externalTransactionId: 'x'.repeat(201) }],
    ['roundId ausente', { roundId: undefined }],
    ['gameId numérico', { gameId: 7 }],
    ['texto com byte nulo', { roundId: 'round\u0000' }],
    ['texto com surrogate solto', { gameId: 'jogo\ud800x' }],
    ['playerId que não é UUID', { playerId: 'player-1' }],
    ['walletId que não é UUID', { walletId: 'wallet-1' }],
    ['valor com 3 casas', { money: { amount: '1.001', currency: 'BRL' } }],
    ['valor sem casas decimais', { money: { amount: '25', currency: 'BRL' } }],
    ['valor com 1 casa', { money: { amount: '25.5', currency: 'BRL' } }],
    ['valor numérico', { money: { amount: 25, currency: 'BRL' } }],
    ['valor negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['BET com valor zero', { money: { amount: '0.00', currency: 'BRL' } }],
    ['BET com referência', { referenceExternalTransactionId: 'ext-0' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['ROLLBACK sem referência', { kind: 'ROLLBACK' }],
    ['referência vazia', { kind: 'WIN', referenceExternalTransactionId: '' }],
  ])('%s: 400 e nada gravado', async (_caso, overrides) => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet, overrides);
    const antes = await t.contar('wager_transactions');

    const { status, body } = await enviar(pedido, { 'idempotency-key': `k-${randomUUID()}` });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PAYLOAD', message: expect.any(String) });
    expect(await t.contar('wager_transactions')).toBe(antes);
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('POST /wagering/transactions: atomicidade e falha transitória', () => {
  it('falha ao gravar o segundo evento desfaz transação, saldo, lançamento e o primeiro evento', async () => {
    const wallet = await t.criarWallet('100.00');
    const comFalha = await t.variante((b) =>
      b.overrideProvider(UnitOfWork).useFactory(faultyUnitOfWorkFactory(2)),
    );
    const pedido = transacao(wallet);
    const eventosAntes = await t.contar('outbox_messages');

    const response = await t.postTransacao(pedido, chave(pedido), comFalha.baseUrl);

    expect(response.status).toBe(500);
    expect(comFalha.app.get<FaultyUnitOfWork>(UnitOfWork).tentativasNoOutbox).toBe(2);
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(
      await t.contar('wager_transactions', 'external_transaction_id = ?', [
        pedido.externalTransactionId,
      ]),
    ).toBe(0);
    expect(
      await t.contar('wallet_ledger_entries', 'wallet_id = ? and direction = ?', [
        wallet.id,
        'DEBIT',
      ]),
    ).toBe(0);
    expect(await t.contar('outbox_messages')).toBe(eventosAntes);

    // Como nada ficou gravado, o reenvio da mesma requisição é processado normalmente.
    const reenvio = await enviar(pedido);
    expect(reenvio.status).toBe(201);
    expect(reenvio.body.idempotentReplay).toBe(false);
  });

  it('wallet travada além do prazo: 503 com Retry-After, nada gravado, reenvio funciona', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
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

      const { status, body, response } = await enviar(pedido);

      expect(status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(body).toMatchObject({ code: 'TRANSIENT_FAILURE' });
    } finally {
      await dono.rollback();
    }
    expect(await saldo(wallet.id)).toEqual({ balance: '100.00', version: 1 });

    expect((await enviar(pedido)).status).toBe(201);
  });
});

describe('Consultas de transação', () => {
  it('GET /wagering/transactions/:id devolve a transação com o resultado', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const { body } = await enviar(pedido);

    const response = await fetch(`${t.baseUrl}/wagering/transactions/${body.transactionId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transactionId: body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: pedido.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
  });

  it('GET por provider e id externo devolve a mesma transação, com failureCode quando rejeitada', async () => {
    const wallet = await t.criarWallet('1.00');
    const pedido = transacao(wallet);
    const { body } = await enviar(pedido);

    const response = await fetch(
      `${t.baseUrl}/providers/provider-a/wagering/transactions/${pedido.externalTransactionId}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      transactionId: body.transactionId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '1.00', currency: 'BRL' },
    });
  });

  it('transação inexistente: 404; id malformado: 400', async () => {
    const inexistente = await fetch(`${t.baseUrl}/wagering/transactions/${randomUUID()}`);
    const porExterno = await fetch(
      `${t.baseUrl}/providers/provider-a/wagering/transactions/nao-existe`,
    );
    const malformado = await fetch(`${t.baseUrl}/wagering/transactions/nao-e-uuid`);

    expect(inexistente.status).toBe(404);
    expect(await inexistente.json()).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    expect(porExterno.status).toBe(404);
    expect(malformado.status).toBe(400);
  });
});
