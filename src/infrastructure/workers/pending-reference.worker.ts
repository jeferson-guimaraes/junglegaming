import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ReprocessPendingReferences } from '@/application/reprocess-pending-references';
import { loadEnv } from '../config/env';
import { newCorrelationId, runWithCorrelation } from '../observability/correlation';
import { APP_LOGGER, type AppLogger } from '../observability/logger';

/**
 * Agenda os ciclos do reprocessamento de pendentes. Um ciclo nunca se sobrepõe a outro na
 * mesma instância; entre instâncias, quem coordena é o lock da wallet no banco.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private emAndamento: Promise<void> | undefined;

  constructor(
    private readonly reprocess: ReprocessPendingReferences,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (!env.pendingWorkerEnabled) return;
    this.timer = setInterval(() => this.tick(), env.pendingWorkerIntervalMs);
  }

  /** Para de agendar e espera o ciclo em andamento terminar, antes de o pool do banco fechar. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.emAndamento;
  }

  private tick(): void {
    if (this.emAndamento) return;
    this.emAndamento = runWithCorrelation(newCorrelationId(), () => this.ciclo()).finally(() => {
      this.emAndamento = undefined;
    });
  }

  private async ciclo(): Promise<void> {
    try {
      const resumo = await this.reprocess.runOnce();
      const total = Object.values(resumo).reduce((soma, n) => soma + n, 0);
      if (total > 0) this.logger.info(resumo, 'ciclo do worker de pendentes');
      if (resumo.falhas > 0) {
        this.logger.error({ falhas: resumo.falhas }, 'pendentes marcadas como FAILED');
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).name }, 'ciclo do worker de pendentes falhou');
    }
  }
}
