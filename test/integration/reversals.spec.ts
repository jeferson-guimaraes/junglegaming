import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';
import { cadeiaDoLedger, type ResultadoHttp, resumoDaWallet } from '../support/wallet-assertions';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ DB_LOCK_TIMEOUT_MS: '15000' });
});

afterAll(async () => {
  await t?.close();
});

type Wallet = { id: string; playerId: string };

async function enviar(body: Parameters<typeof chave>[0] & Linha): Promise<ResultadoHttp> {
  const response = await t.postTransacao(body, chave(body));
  return { status: response.status, body: (await response.json()) as ResultadoHttp['body'] };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Envia uma transação e devolve o corpo enviado, para ser referenciado depois. */
async function processada(wallet: Wallet, overrides: Linha = {}) {
  const pedido = transacao(wallet, overrides);
  const resposta = await enviar(pedido);
  expect(resposta.status).toBe(201);
  return { pedido, resposta };
}

const reversao = (
  wallet: Wallet,
  kind: 'REFUND' | 'ROLLBACK',
  referencia: string,
  extra: Linha = {},
) => transacao(wallet, { kind, referenceExternalTransactionId: referencia, ...extra });

async function saldo(walletId: string): Promise<string> {
  return (await resumoDaWallet(t, walletId)).balance;
}

describe('REFUND', () => {
  it('devolve o valor de uma BET processada e guarda a referência resolvida', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);

    const { status, body } = await enviar(
      reversao(wallet, 'REFUND', bet.pedido.externalTransactionId),
    );

    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    const [tx] = await t.sql(
      'select reference_transaction_id from wager_transactions where id = ?',
      [body.transactionId],
    );
    expect(tx?.reference_transaction_id).toBe(bet.resposta.body.transactionId);
    const [lancamento] = await t.sql(
      'select direction, amount, balance_before, balance_after from wallet_ledger_entries where transaction_id = ?',
      [body.transactionId],
    );
    expect(lancamento).toEqual({
      direction: 'CREDIT',
      amount: '25.00',
      balance_before: '75.00',
      balance_after: '100.00',
    });
  });

  it('com valor diferente do da BET é rejeitado (sem reversão parcial)', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);

    const { status, body } = await enviar(
      reversao(wallet, 'REFUND', bet.pedido.externalTransactionId, { money: brl('24.99') }),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(await saldo(wallet.id)).toBe('75.00');
  });

  it('de um WIN é rejeitado: REFUND só reverte BET', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await processada(wallet, { kind: 'WIN' });

    const { status, body } = await enviar(
      reversao(wallet, 'REFUND', win.pedido.externalTransactionId),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    expect(await saldo(wallet.id)).toBe('125.00');
  });

  it.each([
    ['outra rodada', (_outra: Wallet) => ({ roundId: 'round-2' })],
    ['outra wallet', (outra: Wallet) => ({ walletId: outra.id, playerId: outra.playerId })],
  ])('de %s é rejeitado com REFERENCE_MISMATCH', async (_caso, diferenca) => {
    const wallet = await t.criarWallet('100.00');
    const outra = await t.criarWallet('100.00');
    const bet = await processada(wallet);

    const { status, body } = await enviar(
      reversao(wallet, 'REFUND', bet.pedido.externalTransactionId, diferenca(outra)),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_MISMATCH');
    expect(await saldo(wallet.id)).toBe('75.00');
    expect(await saldo(outra.id)).toBe('100.00');
  });

  it('de outro provedor não encontra a referência e fica pendente', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);

    const { status } = await enviar(
      reversao(wallet, 'REFUND', bet.pedido.externalTransactionId, { providerId: 'provider-b' }),
    );

    expect(status).toBe(202);
    expect(await saldo(wallet.id)).toBe('75.00');
  });

  it('de uma BET rejeitada é rejeitado: não há o que reverter', async () => {
    const wallet = await t.criarWallet('10.00');
    const bet = transacao(wallet);
    expect((await enviar(bet)).status).toBe(422);

    const { status, body } = await enviar(reversao(wallet, 'REFUND', bet.externalTransactionId));

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(await saldo(wallet.id)).toBe('10.00');
  });
});

describe('ROLLBACK', () => {
  it('de BET credita o valor apostado', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);

    const { status, body } = await enviar(
      reversao(wallet, 'ROLLBACK', bet.pedido.externalTransactionId),
    );

    expect(status).toBe(201);
    expect(body.balance).toEqual(brl('100.00'));
  });

  it('de WIN debita o prêmio', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await processada(wallet, { kind: 'WIN', money: brl('40.00') });

    const { status, body } = await enviar(
      reversao(wallet, 'ROLLBACK', win.pedido.externalTransactionId, { money: brl('40.00') }),
    );

    expect(status).toBe(201);
    expect(body.balance).toEqual(brl('100.00'));
    const [lancamento] = await t.sql(
      'select direction from wallet_ledger_entries where transaction_id = ?',
      [body.transactionId],
    );
    expect(lancamento?.direction).toBe('DEBIT');
  });

  it('de REFUND debita o valor reembolsado', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);
    const refund = reversao(wallet, 'REFUND', bet.pedido.externalTransactionId);
    await enviar(refund);

    const { status, body } = await enviar(
      reversao(wallet, 'ROLLBACK', refund.externalTransactionId),
    );

    expect(status).toBe(201);
    expect(body.balance).toEqual(brl('75.00'));
  });

  it('de WIN já gasto é rejeitado com código próprio, diferente do de aposta sem saldo', async () => {
    const wallet = await t.criarWallet('0.00');
    const win = await processada(wallet, { kind: 'WIN', money: brl('50.00') });
    await processada(wallet, { money: brl('30.00') });

    const { status, body } = await enviar(
      reversao(wallet, 'ROLLBACK', win.pedido.externalTransactionId, { money: brl('50.00') }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
      balance: brl('20.00'),
    });
    expect(await saldo(wallet.id)).toBe('20.00');
    expect(
      await t.contar('wallet_ledger_entries', 'transaction_id = ?', [body.transactionId]),
    ).toBe(0);
  });

  it('de LOSS é rejeitado: não há movimento a desfazer', async () => {
    const wallet = await t.criarWallet('100.00');
    const loss = await processada(wallet, { kind: 'LOSS' });

    const { status, body } = await enviar(
      reversao(wallet, 'ROLLBACK', loss.pedido.externalTransactionId),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });
});

describe('Reversão única por transação', () => {
  it.each([
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'REFUND'],
    ['ROLLBACK', 'ROLLBACK'],
  ] as const)('%s seguido de %s da mesma BET: o segundo é rejeitado', async (primeiro, segundo) => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);
    expect(
      (await enviar(reversao(wallet, primeiro, bet.pedido.externalTransactionId))).status,
    ).toBe(201);

    const { status, body } = await enviar(
      reversao(wallet, segundo, bet.pedido.externalTransactionId),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await saldo(wallet.id)).toBe('100.00');
  });

  it('depois de ROLLBACK do REFUND, a BET continua não podendo ser reembolsada de novo', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);
    const refund = reversao(wallet, 'REFUND', bet.pedido.externalTransactionId);
    await enviar(refund);
    await enviar(reversao(wallet, 'ROLLBACK', refund.externalTransactionId));

    const { status, body } = await enviar(
      reversao(wallet, 'REFUND', bet.pedido.externalTransactionId),
    );

    expect(status).toBe(422);
    expect(body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await saldo(wallet.id)).toBe('75.00');
  });

  it('WIN que referencia a BET não ocupa a vaga de reversão', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = await processada(wallet);
    await processada(wallet, {
      kind: 'WIN',
      referenceExternalTransactionId: bet.pedido.externalTransactionId,
    });

    const { status } = await enviar(reversao(wallet, 'REFUND', bet.pedido.externalTransactionId));

    expect(status).toBe(201);
  });

  it('REFUND e ROLLBACK simultâneos da mesma BET: só um é aplicado (20 wallets)', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => t.criarWallet('100.00')));
    const bets = await Promise.all(wallets.map((wallet) => processada(wallet)));

    const rodadas = await Promise.all(
      wallets.map((wallet, i) => {
        const referencia = bets[i]?.pedido.externalTransactionId as string;
        return Promise.all([
          enviar(reversao(wallet, 'REFUND', referencia)),
          enviar(reversao(wallet, 'ROLLBACK', referencia)),
        ]);
      }),
    );

    for (const [i, par] of rodadas.entries()) {
      const wallet = wallets[i] as Wallet;
      expect(par.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(par.find((r) => r.status === 422)?.body.failureCode).toBe(
        'REFERENCE_ALREADY_REVERSED',
      );
      expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 3,
        debitos: 1,
        creditos: 2, // abertura + a única reversão aplicada
      });
      expect((await cadeiaDoLedger(t, wallet.id)).consistente).toBe(true);
    }
  });
});

describe('Referência ausente', () => {
  it('fica PENDING_REFERENCE: 202, sem mover saldo, com evento e próxima tentativa agendada', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = reversao(wallet, 'ROLLBACK', `nao-chegou-${randomUUID()}`);

    const { status, body } = await enviar(pedido);

    expect(status).toBe(202);
    expect(body).toEqual({
      transactionId: body.transactionId,
      status: 'PENDING_REFERENCE',
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({ balance: '100.00', version: 1 });
    const [tx] = await t.sql(
      'select status, reference_attempts, next_reference_attempt_at, reference_transaction_id from wager_transactions where id = ?',
      [body.transactionId],
    );
    expect(tx).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
      reference_transaction_id: null,
    });
    expect(tx?.next_reference_attempt_at).not.toBeNull();
    const eventos = await t.sql<{ event_type: string; payload: { data: Linha } }>(
      "select event_type, payload from outbox_messages where payload->'data'->>'transactionId' = ?",
      [body.transactionId],
    );
    expect(eventos.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(eventos[0]?.payload.data).toMatchObject({
      referenceExternalTransactionId: pedido.referenceExternalTransactionId,
      nextAttemptAt: expect.any(String),
    });
  });

  it('o replay de uma pendente repete o 202 e não cria outra transação', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet, {
      kind: 'WIN',
      referenceExternalTransactionId: `nao-chegou-${randomUUID()}`,
    });
    const primeira = await enviar(pedido);

    const replay = await enviar(pedido);

    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...primeira.body, idempotentReplay: true });
    expect(
      await t.contar('wager_transactions', 'external_transaction_id = ?', [
        pedido.externalTransactionId,
      ]),
    ).toBe(1);
  });
});
