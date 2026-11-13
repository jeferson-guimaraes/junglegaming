import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Metrics } from '@/application/ports';
import {
  OUTBOX_BATCH_SIZE,
  PublishOutbox,
  type PublishSummary,
} from '@/application/publish-outbox';
import { loadEnv } from '../config/env';
import { APP_LOGGER, type AppLogger } from '../observability/logger';
import { PeriodicTask } from './periodic-task';

/** Agenda os ciclos do publisher da outbox. Toda instância roda o seu; o banco coordena. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly tarefa: PeriodicTask;
  private parando = false;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {
    this.tarefa = new PeriodicTask('outbox-publisher', () => this.ciclo(), logger);
  }

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (env.outboxPublisherEnabled) this.tarefa.start(env.outboxPublisherIntervalMs);
  }

  /** Para antes de o pool do banco e o cliente SQS serem fechados. */
  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    await this.tarefa.stop();
  }

  /** Enquanto o lote vier cheio e sem falha, publica o próximo sem esperar o intervalo. */
  private async ciclo(): Promise<void> {
    let resumo = await this.publicar();
    while (!this.parando && resumo.publicados === OUTBOX_BATCH_SIZE && resumo.reagendados === 0) {
      resumo = await this.publicar();
    }
  }

  private async publicar(): Promise<PublishSummary> {
    const resumo = await this.publishOutbox.runOnce();
    if (resumo.reagendados > 0) {
      this.metrics.increment('wager_retries_total', { component: 'outbox' }, resumo.reagendados);
      this.logger.warn(
        { publicados: resumo.publicados, reagendados: resumo.reagendados },
        'publicação de eventos falhou; nova tentativa agendada',
      );
    }
    for (const evento of resumo.insistentes) {
      this.logger.warn(evento, 'evento da outbox segue sem ser publicado após muitas tentativas');
    }
    return resumo;
  }
}
