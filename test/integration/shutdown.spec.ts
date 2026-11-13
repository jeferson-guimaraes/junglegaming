import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startApp, stopAllApps } from '../support/app-process';
import { createTestDatabase } from '../support/database';
import { chave, transacao } from '../support/test-app';

describe('Processo da aplicação', () => {
  afterEach(async () => {
    await stopAllApps();
  });

  it('sobe, responde liveness com correlationId e encerra limpo ao receber SIGTERM', async () => {
    const app = await startApp();

    const response = await fetch(`${app.baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'corr-processo' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('corr-processo');

    const { exitCode, logs } = await app.stop('SIGTERM');

    expect(exitCode).toBe(0);
    expect(logs.map((l) => l.msg)).toContain('aplicação encerrada');
  }, 15_000);

  it('dispara os hooks de encerramento do NestJS com o sinal recebido', async () => {
    const app = await startApp();

    const { logs } = await app.stop('SIGTERM');

    const hook = logs.find((l) => l.msg === 'hooks de encerramento executados');
    expect(hook).toMatchObject({ sinal: 'SIGTERM' });
    const mensagens = logs.map((l) => l.msg);
    expect(mensagens.indexOf('hooks de encerramento executados')).toBeLessThan(
      mensagens.indexOf('aplicação encerrada'),
    );
  }, 15_000);

  it('identifica a instância em cada linha de log', async () => {
    const app = await startApp();

    const { logs } = await app.stop('SIGTERM');

    const iniciada = logs.find((l) => l.msg === 'aplicação iniciada');
    expect(iniciada?.pid).toBe(app.pid);
  }, 15_000);

  it('SIGTERM com requisição em andamento: ela é concluída e respondida antes de o processo sair', async () => {
    const db = await createTestDatabase();
    const dono = db.orm.em.fork();
    try {
      const app = await startApp({ DATABASE_URL: db.url, DB_LOCK_TIMEOUT_MS: '6000' });
      const playerId = randomUUID();
      const criada = await fetch(`${app.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      });
      const wallet = { id: ((await criada.json()) as { id: string }).id, playerId };

      // A wallet fica travada por fora: a aposta entra e espera o lock dentro da aplicação.
      await dono.begin();
      await dono
        .getConnection()
        .execute(
          'select id from wallets where id = ? for update',
          [wallet.id],
          'all',
          dono.getTransactionContext(),
        );
      const pedido = transacao(wallet);
      const emAndamento = fetch(`${app.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...chave(pedido) },
        body: JSON.stringify(pedido),
      });
      await Bun.sleep(500);

      const encerramento = app.stop('SIGTERM');
      await Bun.sleep(500);
      await dono.rollback();

      const response = await emAndamento;
      expect(response.status).toBe(201);
      expect((await encerramento).exitCode).toBe(0);
    } finally {
      if (dono.isInTransaction()) await dono.rollback();
      await stopAllApps();
      await db.drop();
    }
  }, 30_000);
});
