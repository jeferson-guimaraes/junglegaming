import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

type Wallet = { id: string; playerId: string };

interface Pagina {
  items: (Linha & { id: string; balanceAfter: { amount: string } })[];
  nextCursor: string | null;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function apostar(wallet: Wallet, amount = '1.00'): Promise<void> {
  const pedido = transacao(wallet, { money: brl(amount) });
  const response = await t.postTransacao(pedido, chave(pedido));
  expect(response.status).toBe(201);
}

async function pagina(walletId: string, query = ''): Promise<{ status: number; body: Pagina }> {
  const response = await fetch(`${t.baseUrl}/wallets/${walletId}/ledger${query}`);
  return { status: response.status, body: (await response.json()) as Pagina };
}

async function reconciliar(walletId: string) {
  const response = await fetch(`${t.baseUrl}/wallets/${walletId}/reconciliation`, {
    method: 'POST',
  });
  return { status: response.status, body: (await response.json()) as Linha };
}

describe('GET /wallets/:walletId/ledger', () => {
  it('devolve os lançamentos na ordem de gravação, no formato do contrato', async () => {
    const wallet = await t.criarWallet('100.00');
    await apostar(wallet, '30.00');

    const { status, body } = await pagina(wallet.id);

    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toEqual([
      {
        id: expect.any(String),
        walletId: wallet.id,
        transactionId: expect.any(String),
        direction: 'CREDIT',
        money: brl('100.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('100.00'),
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        walletId: wallet.id,
        transactionId: expect.any(String),
        direction: 'DEBIT',
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
        createdAt: expect.any(String),
      },
    ]);
  });

  it('pagina por cursor sem repetir nem pular, mesmo com lançamentos novos entre as páginas', async () => {
    const wallet = await t.criarWallet('100.00');
    for (let i = 0; i < 6; i++) await apostar(wallet); // 7 lançamentos com a abertura

    const primeira = await pagina(wallet.id, '?limit=3');
    expect(primeira.body.items).toHaveLength(3);
    expect(primeira.body.nextCursor).toEqual(expect.any(String));

    // Chegam lançamentos novos, desta e de outra wallet, antes de a segunda página ser pedida.
    const outra = await t.criarWallet('50.00');
    await apostar(outra);
    await apostar(wallet);
    await apostar(wallet);

    const vistos = [...primeira.body.items];
    let cursor = primeira.body.nextCursor;
    while (cursor) {
      const proxima = await pagina(wallet.id, `?limit=3&cursor=${encodeURIComponent(cursor)}`);
      expect(proxima.status).toBe(200);
      vistos.push(...proxima.body.items);
      cursor = proxima.body.nextCursor;
    }

    expect(vistos).toHaveLength(9);
    expect(new Set(vistos.map((i) => i.id)).size).toBe(9);
    expect(vistos.every((i) => i.walletId === wallet.id)).toBe(true);
    // Em ordem: o saldo só cai de 1 em 1 depois da abertura.
    expect(vistos.map((i) => i.balanceAfter.amount)).toEqual([
      '100.00',
      '99.00',
      '98.00',
      '97.00',
      '96.00',
      '95.00',
      '94.00',
      '93.00',
      '92.00',
    ]);
  });

  it('repetir o mesmo cursor devolve a mesma página', async () => {
    const wallet = await t.criarWallet('100.00');
    for (let i = 0; i < 4; i++) await apostar(wallet);
    const primeira = await pagina(wallet.id, '?limit=2');
    const consulta = `?limit=2&cursor=${encodeURIComponent(primeira.body.nextCursor as string)}`;

    const a = await pagina(wallet.id, consulta);
    await apostar(wallet);
    const b = await pagina(wallet.id, consulta);

    expect(b.body.items).toEqual(a.body.items);
  });

  it('a última página exata não anuncia uma página seguinte', async () => {
    const wallet = await t.criarWallet('100.00');
    await apostar(wallet);

    const { body } = await pagina(wallet.id, '?limit=2');

    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it('wallet sem lançamentos devolve lista vazia', async () => {
    const wallet = await t.criarWallet('0.00');

    expect((await pagina(wallet.id)).body).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ['limit zero', '?limit=0'],
    ['limit acima do teto', '?limit=201'],
    ['limit não numérico', '?limit=abc'],
    ['cursor que não é base64 de um cursor', '?cursor=isto-nao-e-cursor'],
    ['cursor adulterado', `?cursor=${Buffer.from('{"s":"1; drop table"}').toString('base64url')}`],
  ])('%s: 400', async (_caso, query) => {
    const wallet = await t.criarWallet('10.00');

    const { status, body } = await pagina(wallet.id, query);

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('wallet inexistente: 404', async () => {
    expect((await pagina(randomUUID())).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('wallet consistente: saldo guardado igual ao reconstruído pelo ledger', async () => {
    const wallet = await t.criarWallet('1000.00');
    await apostar(wallet, '25.00');

    const { status, body } = await reconciliar(wallet.id);

    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('wallet aberta com saldo zero e sem lançamentos é consistente', async () => {
    const wallet = await t.criarWallet('0.00');

    expect((await reconciliar(wallet.id)).body).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      calculatedBalance: brl('0.00'),
    });
  });

  it.each([
    ['saldo guardado maior que o do ledger', '980.00', '5.00'],
    ['saldo guardado menor que o do ledger', '900.00', '-75.00'],
  ])(
    'divergência (%s) é sinalizada, contada em métrica e não corrigida',
    async (_caso, adulterado, diferenca) => {
      const wallet = await t.criarWallet('1000.00');
      await apostar(wallet, '25.00');
      await t.sql('update wallets set balance = ? where id = ?', [adulterado, wallet.id]);
      const metricaAntes = await divergencias();

      const { status, body } = await reconciliar(wallet.id);

      expect(status).toBe(200);
      expect(body).toEqual({
        walletId: wallet.id,
        storedBalance: brl(adulterado),
        calculatedBalance: brl('975.00'),
        difference: brl(diferenca),
        consistent: false,
        checkedEntries: 2,
      });
      expect(await divergencias()).toBe(metricaAntes + 1);
      const [linha] = await t.sql('select balance from wallets where id = ?', [wallet.id]);
      expect(linha?.balance).toBe(adulterado);
    },
  );

  it('wallet inexistente: 404; id malformado: 400', async () => {
    expect((await reconciliar(randomUUID())).status).toBe(404);
    expect((await reconciliar('nao-e-uuid')).status).toBe(400);
  });
});

async function divergencias(): Promise<number> {
  const texto = await (await fetch(`${t.baseUrl}/metrics`)).text();
  const linha = texto
    .split('\n')
    .find((l) => l.startsWith('wallet_reconciliation_divergences_total '));
  return linha ? Number(linha.split(' ')[1]) : 0;
}
