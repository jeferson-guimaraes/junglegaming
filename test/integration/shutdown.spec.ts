import { afterEach, describe, expect, it } from 'bun:test';
import { startApp, stopAllApps } from '../support/app-process';

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
});
