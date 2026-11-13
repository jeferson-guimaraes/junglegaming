import { describe, expect, it } from 'bun:test';
import { createLogger } from '@/infrastructure/observability/logger';
import { PeriodicTask } from '@/infrastructure/workers/periodic-task';

const pausa = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = createLogger({ level: 'silent' });

describe('PeriodicTask', () => {
  it('nunca sobrepõe dois ciclos, mesmo quando o ciclo demora mais que o intervalo', async () => {
    let simultaneos = 0;
    let maximo = 0;
    let ciclos = 0;
    const tarefa = new PeriodicTask(
      'teste',
      async () => {
        simultaneos += 1;
        maximo = Math.max(maximo, simultaneos);
        ciclos += 1;
        await pausa(30);
        simultaneos -= 1;
      },
      logger,
    );

    tarefa.start(5);
    await pausa(120);
    await tarefa.stop();

    expect(maximo).toBe(1);
    expect(ciclos).toBeGreaterThanOrEqual(2);
  });

  it('stop espera o ciclo em andamento terminar e não agenda outro', async () => {
    let terminou = false;
    let ciclos = 0;
    const tarefa = new PeriodicTask(
      'teste',
      async () => {
        ciclos += 1;
        await pausa(60);
        terminou = true;
      },
      logger,
    );
    tarefa.start(5);
    await pausa(20);

    await tarefa.stop();

    expect(terminou).toBe(true);
    const ciclosAoParar = ciclos;
    await pausa(40);
    expect(ciclos).toBe(ciclosAoParar);
  });

  it('um ciclo que falha não interrompe os próximos', async () => {
    let ciclos = 0;
    const tarefa = new PeriodicTask(
      'teste',
      async () => {
        ciclos += 1;
        if (ciclos === 1) throw new Error('falhou');
      },
      logger,
    );

    tarefa.start(5);
    await pausa(60);
    await tarefa.stop();

    expect(ciclos).toBeGreaterThan(1);
  });
});
