import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../observability/logger';

/** Registra que o ciclo de encerramento do NestJS rodou, e com qual sinal. */
@Injectable()
export class ShutdownHookLogger implements OnApplicationShutdown {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  onApplicationShutdown(signal?: string): void {
    this.logger.info({ sinal: signal }, 'hooks de encerramento executados');
  }
}
