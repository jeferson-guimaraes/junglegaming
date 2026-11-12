import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { gracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';
import { createLogger } from '@/infrastructure/observability/logger';

function loggerCapturado() {
  const linhas: Record<string, unknown>[] = [];
  const destino = new Writable({
    write(chunk, _encoding, callback) {
      linhas.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  return { logger: createLogger({ destination: destino }), linhas };
}

describe('gracefulShutdown', () => {
  it('fecha a aplicação repassando o sinal e sai com código 0', async () => {
    const { logger, linhas } = loggerCapturado();
    const sinaisRecebidos: string[] = [];

    const codigo = await gracefulShutdown({
      signal: 'SIGTERM',
      close: async (sinal) => {
        sinaisRecebidos.push(sinal);
      },
      logger,
      timeoutMs: 1000,
    });

    expect(codigo).toBe(0);
    expect(sinaisRecebidos).toEqual(['SIGTERM']);
    expect(linhas.map((l) => l.msg)).toEqual(['encerrando aplicação', 'aplicação encerrada']);
  });

  it('sai com código 1 e registra a causa quando o fechamento falha', async () => {
    const { logger, linhas } = loggerCapturado();

    const codigo = await gracefulShutdown({
      signal: 'SIGTERM',
      close: async () => {
        throw new Error('pool não fechou');
      },
      logger,
      timeoutMs: 1000,
    });

    expect(codigo).toBe(1);
    const erro = linhas.find((l) => l.msg === 'falha ao encerrar aplicação');
    expect(erro).toMatchObject({ level: 'error', err: { message: 'pool não fechou' } });
  });

  it('desiste e sai com código 1 quando o fechamento passa do prazo', async () => {
    const { logger, linhas } = loggerCapturado();
    const inicio = performance.now();

    const codigo = await gracefulShutdown({
      signal: 'SIGTERM',
      close: () => new Promise<void>(() => {}), // nunca termina
      logger,
      timeoutMs: 50,
    });

    expect(codigo).toBe(1);
    expect(performance.now() - inicio).toBeLessThan(500);
    expect(linhas.at(-1)).toMatchObject({
      level: 'error',
      msg: 'prazo de encerramento esgotado',
      timeoutMs: 50,
    });
  });
});
