import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type AppProcess, startApp, stopAllApps } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { chave, type Linha, transacao } from '../support/test-app';
import {
  cadeiaDoLedger,
  type ResultadoHttp,
  resumoDaWallet,
  walletsDivergentesDoLedger,
} from '../support/wallet-assertions';

const INSTANCIAS = 3;

let db: TestDatabase;
let apps: AppProcess[];
let proxima = 0;

const banco = {
  sql: <T = Linha>(texto: string, params: unknown[] = []) =>
    db.orm.em.getConnection().execute<T[]>(texto, params),
};

/** Distribui as requisições entre os processos em rodízio. */
function instancia(): AppProcess {
  const app = apps[proxima % apps.length];
  proxima += 1;
  if (!app) throw new Error('nenhuma instância');
  return app;
}

async function criarWallet(saldo: string): Promise<{ id: string; playerId: string }> {
  const playerId = randomUUID();
  const response = await fetch(`${instancia().baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: saldo, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, playerId };
}

async function enviar(body: Parameters<typeof chave>[0] & Linha): Promise<ResultadoHttp> {
  const response = await fetch(`${instancia().baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...chave(body) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ResultadoHttp['body'] };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

beforeAll(async () => {
  db = await createTestDatabase();
  apps = await Promise.all(
    Array.from({ length: INSTANCIAS }, () =>
      startApp({ DATABASE_URL: db.url, DB_LOCK_TIMEOUT_MS: '15000' }),
    ),
  );
}, 30_000);

afterAll(async () => {
  await stopAllApps();
  await db?.drop();
}, 30_000);

describe(`Concorrência: ${INSTANCIAS} processos reais no mesmo banco`, () => {
  it('são processos distintos do sistema operacional', () => {
    expect(new Set(apps.map((a) => a.pid)).size).toBe(INSTANCIAS);
    expect(apps.map((a) => a.pid)).not.toContain(process.pid);
  });

  it('a mesma aposta enviada 60 vezes, espalhada pelas instâncias, gera um único débito', async () => {
    const wallet = await criarWallet('100.00');
    const pedido = transacao(wallet);

    const respostas = await Promise.all(Array.from({ length: 60 }, () => enviar(pedido)));

    expect(respostas.map((r) => r.status)).toEqual(Array(60).fill(201));
    expect(respostas.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await resumoDaWallet(banco, wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      debitos: 1,
      transacoes: 2,
      eventos: 4,
    });
  }, 30_000);

  it('cenário obrigatório 100/80/80 com cada aposta em uma instância diferente (20 wallets)', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => criarWallet('100.00')));

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
      expect(par.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await resumoDaWallet(banco, wallet.id)).toMatchObject({
        balance: '20.00',
        version: 2,
        debitos: 1,
      });
    }
  }, 30_000);

  it('45 apostas de 10 disputando saldo 100 pelas 3 instâncias: 10 passam, saldo zero, ledger encadeado', async () => {
    const wallet = await criarWallet('100.00');

    const respostas = await Promise.all(
      Array.from({ length: 45 }, () => enviar(transacao(wallet, { money: brl('10.00') }))),
    );

    expect(respostas.filter((r) => r.status === 201)).toHaveLength(10);
    expect(respostas.filter((r) => r.status === 422)).toHaveLength(35);
    expect(await resumoDaWallet(banco, wallet.id)).toMatchObject({
      balance: '0.00',
      version: 11,
      debitos: 10,
    });
    const cadeia = await cadeiaDoLedger(banco, wallet.id);
    expect(cadeia).toEqual({ consistente: true, menorSaldo: '0.00', saldoFinal: '0.00' });
  }, 30_000);

  it('invariante final: em toda wallet usada acima, o saldo é igual ao reconstruído pelo ledger', async () => {
    expect(await walletsDivergentesDoLedger(banco)).toEqual([]);
  });
});
