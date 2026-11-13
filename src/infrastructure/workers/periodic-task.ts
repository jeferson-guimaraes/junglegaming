import { newCorrelationId, runWithCorrelation } from '../observability/correlation';
import type { AppLogger } from '../observability/logger';

/**
 * Executa `ciclo` a cada `intervalMs`, sem nunca sobrepor dois ciclos na mesma instância.
 * Um erro no ciclo é registrado e não interrompe os próximos. Cada ciclo tem um correlationId.
 */
export class PeriodicTask {
  private timer: ReturnType<typeof setInterval> | undefined;
  private emAndamento: Promise<void> | undefined;

  constructor(
    private readonly nome: string,
    private readonly ciclo: () => Promise<void>,
    private readonly logger: AppLogger,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  /** Para de agendar e espera o ciclo em andamento terminar. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.emAndamento;
  }

  private tick(): void {
    if (this.emAndamento) return;
    this.emAndamento = runWithCorrelation(newCorrelationId(), () => this.ciclo())
      .catch((err: unknown) => {
        this.logger.warn({ err: (err as Error)?.name, tarefa: this.nome }, 'ciclo falhou');
      })
      .finally(() => {
        this.emAndamento = undefined;
      });
  }
}
