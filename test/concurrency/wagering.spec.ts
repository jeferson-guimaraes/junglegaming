import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';
import {
  cadeiaDoLedger,
  type ResultadoHttp,
  resumoDaWallet,
  walletsDivergentesDoLedger,
} from '../support/wallet-assertions';

let t: TestApp;

beforeAll(async () => {
  // Prazo de lock folgado: nestes testes nenhuma requisição pode terminar em 503.
  t = await startTestApp({ DB_LOCK_TIMEOUT_MS: '15000' });
});

afterAll(async () => {
  await t?.close();
});

async function enviar(body: Parameters<typeof chave>[0] & Linha): Promise<ResultadoHttp> {
  const response = await t.postTransacao(body, chave(body));
  return { status: response.status, body: (await response.json()) as ResultadoHttp['body'] };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('Concorrência: uma instância, requisições realmente paralelas', () => {
  it('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);

    const respostas = await Promise.all(Array.from({ length: 50 }, () => enviar(pedido)));

    expect(respostas.map((r) => r.status)).toEqual(Array(50).fill(201));
    expect(respostas.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(respostas.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(respostas.map((r) => r.body.balance?.amount))).toEqual(new Set(['75.00']));
    expect(await resumoDaWallet(t, wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
      debitos: 1,
      creditos: 1, // abertura
      transacoes: 2, // abertura + aposta
      eventos: 4, // 2 da abertura + 2 da aposta
    });
  });

  it('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas (repetido em 25 wallets)', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => t.criarWallet('100.00')));

    const rodadas = await Promise.all(
      wallets.map((wallet) =>
        Promise.all([
          enviar(transacao(wallet, { money: brl('80.00') })),
          enviar(transacao(wallet, { money: brl('80.00') })),
        ]),
      ),
    );

    for (const [indice, par] of rodadas.entries()) {
      const wallet = wallets[indice];
      if (!wallet) throw new Error('wallet ausente');
      expect(par.map((r) => r.status).sort()).toEqual([201, 422]);
      const rejeitada = par.find((r) => r.status === 422);
      expect(rejeitada?.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
        balance: '20.00',
        version: 2,
        debitos: 1,
      });
    }
  });

  it('30 apostas de 10 disputando saldo 100: exatamente 10 passam e o saldo nunca fica negativo', async () => {
    const wallet = await t.criarWallet('100.00');

    const respostas = await Promise.all(
      Array.from({ length: 30 }, () => enviar(transacao(wallet, { money: brl('10.00') }))),
    );

    expect(respostas.filter((r) => r.status === 201)).toHaveLength(10);
    expect(respostas.filter((r) => r.status === 422)).toHaveLength(20);
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
      balance: '0.00',
      version: 11,
      debitos: 10,
      transacoes: 31,
    });
    const cadeia = await cadeiaDoLedger(t, wallet.id);
    expect(cadeia.consistente).toBe(true);
    expect(cadeia.menorSaldo).toBe('0.00');
  });

  it('apostas e prêmios misturados: o saldo final bate com o ledger, lançamento a lançamento', async () => {
    const wallet = await t.criarWallet('50.00');
    const pedidos = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? transacao(wallet, { kind: 'BET', money: brl('7.00') })
        : transacao(wallet, { kind: 'WIN', money: brl('3.00') }),
    );

    const respostas = await Promise.all(pedidos.map((p) => enviar(p)));

    expect(respostas.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    const resumo = await resumoDaWallet(t, wallet.id);
    const cadeia = await cadeiaDoLedger(t, wallet.id);
    expect(cadeia.consistente).toBe(true);
    expect(cadeia.saldoFinal).toBe(resumo.balance);
    // A versão sobe uma vez por lançamento; a abertura já nasce na versão 1.
    expect(resumo.version).toBe(resumo.debitos + resumo.creditos);
    expect(Number(cadeia.menorSaldo)).toBeGreaterThanOrEqual(0);
  });

  it('wallets diferentes em paralelo: todas processam e cada saldo fica certo', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => t.criarWallet('100.00')));

    const respostas = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => enviar(transacao(wallet, { money: brl('10.00') }))),
      ),
    );

    expect(respostas.map((r) => r.status)).toEqual(Array(100).fill(201));
    for (const wallet of wallets) {
      expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
        balance: '50.00',
        version: 6,
        debitos: 5,
      });
    }
  });

  it('uma wallet travada não bloqueia as outras', async () => {
    const travada = await t.criarWallet('100.00');
    const livre = await t.criarWallet('100.00');
    const dono = t.db.orm.em.fork();
    await dono.begin();
    try {
      await dono
        .getConnection()
        .execute(
          'select id from wallets where id = ? for update',
          [travada.id],
          'all',
          dono.getTransactionContext(),
        );
      const presa = enviar(transacao(travada));

      const inicio = Date.now();
      const respostas = await Promise.all(
        Array.from({ length: 5 }, () => enviar(transacao(livre, { money: brl('10.00') }))),
      );

      expect(respostas.map((r) => r.status)).toEqual(Array(5).fill(201));
      expect(Date.now() - inicio).toBeLessThan(3000);
      await dono.rollback();
      expect((await presa).status).toBe(201);
    } finally {
      if (dono.isInTransaction()) await dono.rollback();
    }
  });

  it('invariante final: em toda wallet usada acima, o saldo é igual ao reconstruído pelo ledger', async () => {
    expect(await walletsDivergentesDoLedger(t)).toEqual([]);
  });
});
