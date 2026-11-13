import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PublishOutbox } from '@/application/publish-outbox';
import { loadEnv } from '../config/env';
import { APP_LOGGER, type AppLogger } from '../observability/logger';
import { PeriodicTask } from './periodic-task';

/** Agenda os ciclos do publisher da outbox. Toda instância roda o seu; o banco coordena. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly tarefa: PeriodicTask;

  constructor(
    private readonly publishOutbox: PublishOutbox,
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
    await this.tarefa.stop();
  }

  private async ciclo(): Promise<void> {
    const resumo = await this.publishOutbox.runOnce();
    if (resumo.reagendados > 0) {
      this.logger.warn(
        { publicados: resumo.publicados, reagendados: resumo.reagendados },
        'publicação de eventos falhou; nova tentativa agendada',
      );
    }
    for (const evento of resumo.insistentes) {
      this.logger.warn(evento, 'evento da outbox segue sem ser publicado após muitas tentativas');
    }
  }
}
