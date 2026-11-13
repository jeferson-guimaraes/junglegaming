import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Metrics } from '@/application/ports';
import { ReprocessPendingReferences } from '@/application/reprocess-pending-references';
import { loadEnv } from '../config/env';
import { APP_LOGGER, type AppLogger } from '../observability/logger';
import { PeriodicTask } from './periodic-task';

/**
 * Agenda os ciclos do reprocessamento de pendentes. Toda instância roda o seu; quem coordena
 * entre instâncias é o lock da wallet no banco.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly tarefa: PeriodicTask;
  private parando = false;

  constructor(
    private readonly reprocess: ReprocessPendingReferences,
    private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {
    this.tarefa = new PeriodicTask('pending-references', () => this.ciclo(), logger);
  }

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (env.pendingWorkerEnabled) this.tarefa.start(env.pendingWorkerIntervalMs);
  }

  /** Para de agendar e espera a pendente em andamento terminar, antes de o pool do banco fechar. */
  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    await this.tarefa.stop();
  }

  private async ciclo(): Promise<void> {
    const resumo = await this.reprocess.runOnce(() => this.parando);
    const { problemas, ...contagem } = resumo;
    const repetidas = resumo.aguardando + resumo.adiadas;
    if (repetidas > 0) {
      this.metrics.increment('wager_retries_total', { component: 'pending_reference' }, repetidas);
    }
    if (Object.values(contagem).some((n) => n > 0)) {
      this.logger.info(contagem, 'ciclo do worker de pendentes');
    }
    for (const problema of problemas) {
      if (problema.desfecho === 'falha') {
        this.logger.error(problema, 'pendente marcada como FAILED');
      } else {
        this.logger.warn(problema, 'pendente adiada para o próximo ciclo');
      }
    }
  }
}
