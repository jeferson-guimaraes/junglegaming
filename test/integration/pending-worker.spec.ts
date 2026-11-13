import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ClockPort, UnitOfWork } from '@/application/ports';
import { ReprocessPendingReferences } from '@/application/reprocess-pending-references';
import { FakeClock } from '../support/fake-clock';
import { faultyUnitOfWorkFactory } from '../support/faulty-unit-of-work';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';
import { cadeiaDoLedger, type ResultadoHttp, resumoDaWallet } from '../support/wallet-assertions';

const clock = new FakeClock();
let t: TestApp;
let worker: ReprocessPendingReferences;

beforeAll(async () => {
  t = await startTestApp({ DB_LOCK_TIMEOUT_MS: '500' }, (b) =>
    b.overrideProvider(ClockPort).useValue(clock),
  );
  worker = t.app.get(ReprocessPendingReferences);
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

async function estado(transactionId: string) {
  const [tx] = await t.sql<{
    status: string;
    failure_code: string | null;
    reference_attempts: number;
    next_reference_attempt_at: string | null;
    reference_transaction_id: string | null;
  }>(
    'select status, failure_code, reference_attempts, next_reference_attempt_at, reference_transaction_id from wager_transactions where id = ?',
    [transactionId],
  );
  if (!tx) throw new Error('transação não encontrada');
  return tx;
}

const tiposDeEvento = async (transactionId: string) =>
  (
    await t.sql<{ event_type: string }>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [transactionId],
    )
  ).map((e) => e.event_type);

/** Um WIN que referencia uma BET que ainda não chegou. */
async function winPendente(wallet: Wallet, referencia = `bet-${randomUUID()}`) {
  const pedido = transacao(wallet, {
    kind: 'WIN',
    money: brl('40.00'),
    referenceExternalTransactionId: referencia,
  });
  const resposta = await enviar(pedido);
  expect(resposta.status).toBe(202);
  return { pedido, referencia, id: resposta.body.transactionId };
}

describe('Worker de referências pendentes', () => {
  it('não faz nada antes do horário agendado', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);

    clock.avancar(4);
    await worker.runOnce();

    expect(await estado(win.id)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
  });

  it('quando a referência chega, aplica a transação: saldo, lançamento, eventos e replay 201', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);
    const bet = transacao(wallet, { externalTransactionId: win.referencia });
    const aposta = await enviar(bet);
    expect(aposta.status).toBe(201);

    clock.avancar(5);
    await worker.runOnce();

    expect(await estado(win.id)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      next_reference_attempt_at: null,
      reference_transaction_id: aposta.body.transactionId,
    });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
      balance: '115.00',
      version: 3,
      debitos: 1,
      creditos: 2,
    });
    expect(await tiposDeEvento(win.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const replay = await enviar(win.pedido);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('115.00'),
      idempotentReplay: true,
    });
  });

  it('referência ausente: conta a tentativa e dobra o intervalo (5, 10, 20, 40, 80, 160 s)', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);
    const criadaEm = clock.now().getTime();
    const esperas: number[] = [5];
    let decorrido = 0;

    for (const espera of [5, 10, 20, 40, 80]) {
      clock.avancar(espera);
      decorrido += espera;
      await worker.runOnce();
      const tx = await estado(win.id);
      expect(tx.status).toBe('PENDING_REFERENCE');
      esperas.push(
        (new Date(tx.next_reference_attempt_at as string).getTime() - criadaEm) / 1000 - decorrido,
      );
    }

    expect(esperas).toEqual([5, 10, 20, 40, 80, 160]);
    expect((await estado(win.id)).reference_attempts).toBe(5);
    expect(await tiposDeEvento(win.id)).toEqual(['WagerTransactionPendingReference']);
  });

  it('esgotadas as 6 tentativas: REJECTED com REFERENCE_NOT_FOUND, evento publicado, saldo intacto', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);

    for (const espera of [5, 10, 20, 40, 80, 160]) {
      clock.avancar(espera);
      await worker.runOnce();
    }

    expect(await estado(win.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 6,
      next_reference_attempt_at: null,
    });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({ balance: '100.00', version: 1 });
    expect(await tiposDeEvento(win.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    const replay = await enviar(win.pedido);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: true,
    });
  });

  it('referência que termina rejeitada: a dependente é rejeitada com REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await t.criarWallet('10.00');
    const win = await winPendente(wallet);
    const bet = transacao(wallet, { externalTransactionId: win.referencia });
    expect((await enviar(bet)).status).toBe(422);

    clock.avancar(5);
    await worker.runOnce();

    expect(await estado(win.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('10.00');
  });

  it('cadeia em que a BET nunca chega: o REFUND esgota o prazo e o ROLLBACK, que só esperava, é rejeitado em seguida', async () => {
    const wallet = await t.criarWallet('100.00');
    const refund = transacao(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: `bet-${randomUUID()}`,
    });
    const rollback = transacao(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const r1 = await enviar(rollback);
    const r2 = await enviar(refund);
    expect([r1.status, r2.status]).toEqual([202, 202]);

    // Enquanto o REFUND existe e aguarda, o ROLLBACK só reagenda: não gasta tentativas (I18).
    for (let i = 0; i < 5; i++) {
      clock.avancar(1000);
      await worker.runOnce();
    }
    expect(await estado(r2.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 5,
    });
    expect(await estado(r1.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });

    for (let i = 0; i < 3; i++) {
      clock.avancar(1000);
      await worker.runOnce();
    }
    expect(await estado(r2.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await estado(r1.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
      reference_attempts: 0,
    });
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('100.00');
  });

  it('cadeia fora de ordem dentro do prazo: BET chega por último e todas terminam PROCESSED', async () => {
    const wallet = await t.criarWallet('100.00');
    const bet = transacao(wallet);
    const refund = transacao(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = transacao(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const r1 = await enviar(rollback);
    const r2 = await enviar(refund);
    clock.avancar(5);
    await worker.runOnce();

    const r3 = await enviar(bet);
    expect(r3.status).toBe(201);
    for (let i = 0; i < 4; i++) {
      clock.avancar(20);
      await worker.runOnce();
    }

    expect((await estado(r2.body.transactionId)).status).toBe('PROCESSED');
    expect((await estado(r1.body.transactionId)).status).toBe('PROCESSED');
    // BET −25, REFUND +25, ROLLBACK do REFUND −25.
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
      balance: '75.00',
      version: 4,
      debitos: 2,
      creditos: 2,
    });
    const cadeia = await cadeiaDoLedger(t, wallet.id);
    expect(cadeia).toMatchObject({ consistente: true, saldoFinal: '75.00' });
  });

  it('dois workers ao mesmo tempo não processam a mesma pendente duas vezes', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => t.criarWallet('100.00')));
    const pendentes = await Promise.all(wallets.map((wallet) => winPendente(wallet)));
    await Promise.all(
      pendentes.map((p, i) =>
        enviar(transacao(wallets[i] as Wallet, { externalTransactionId: p.referencia })),
      ),
    );
    const outraInstancia = await t.variante((b) => b.overrideProvider(ClockPort).useValue(clock));
    const outroWorker = outraInstancia.app.get(ReprocessPendingReferences);

    clock.avancar(5);
    await Promise.all([
      worker.runOnce(),
      outroWorker.runOnce(),
      worker.runOnce(),
      outroWorker.runOnce(),
    ]);

    for (const [i, pendente] of pendentes.entries()) {
      expect((await estado(pendente.id)).status).toBe('PROCESSED');
      expect(await resumoDaWallet(t, (wallets[i] as Wallet).id)).toMatchObject({
        balance: '115.00',
        version: 3,
        creditos: 2,
      });
      expect(await tiposDeEvento(pendente.id)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    }
  });

  it('dois workers ao mesmo tempo contam uma única tentativa quando a referência não chegou', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);
    const outraInstancia = await t.variante((b) => b.overrideProvider(ClockPort).useValue(clock));
    const outroWorker = outraInstancia.app.get(ReprocessPendingReferences);

    clock.avancar(5);
    await Promise.all([worker.runOnce(), outroWorker.runOnce()]);

    expect((await estado(win.id)).reference_attempts).toBe(1);
  });

  it('wallet travada além do prazo: a pendente fica para o próximo ciclo, sem gastar tentativa', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);
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
      clock.avancar(5);

      await worker.runOnce();
    } finally {
      await dono.rollback();
    }

    expect(await estado(win.id)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
  });

  it('erro inesperado e permanente no reprocessamento: a transação termina FAILED, auditável, sem mover saldo', async () => {
    const wallet = await t.criarWallet('100.00');
    const win = await winPendente(wallet);
    await enviar(transacao(wallet, { externalTransactionId: win.referencia }));
    const comFalha = await t.variante((b) =>
      b
        .overrideProvider(ClockPort)
        .useValue(clock)
        .overrideProvider(UnitOfWork)
        .useFactory(faultyUnitOfWorkFactory(1)),
    );

    clock.avancar(5);
    await comFalha.app.get(ReprocessPendingReferences).runOnce();

    expect(await estado(win.id)).toMatchObject({
      status: 'FAILED',
      failure_code: 'INFRASTRUCTURE_FAILURE',
      next_reference_attempt_at: null,
    });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
    expect(await t.contar('wallet_ledger_entries', 'transaction_id = ?', [win.id])).toBe(0);
    const replay = await enviar(win.pedido);
    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({
      status: 'FAILED',
      failureCode: 'INFRASTRUCTURE_FAILURE',
      idempotentReplay: true,
    });
  });
});
