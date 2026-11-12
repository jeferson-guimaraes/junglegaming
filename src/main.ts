import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';
import { gracefulShutdown } from './infrastructure/lifecycle/graceful-shutdown';
import {
  APP_LOGGER,
  type AppLogger,
  createLogger,
  NestPinoLogger,
} from './infrastructure/observability/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<AppLogger>(APP_LOGGER);
  app.useLogger(new NestPinoLogger(logger));

  let encerrando = false;
  const encerrar = async (sinal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    const codigo = await gracefulShutdown({
      signal: sinal,
      // A implementação aceita o sinal e o repassa aos hooks; a interface pública não o declara.
      close: (s) => (app as unknown as { close(signal?: string): Promise<void> }).close(s),
      logger,
      timeoutMs: env.shutdownTimeoutMs,
    });
    process.exit(codigo);
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));

  await app.listen(env.port);
  const endereco = app.getHttpServer().address() as AddressInfo;
  logger.info({ port: endereco.port }, 'aplicação iniciada');
}

bootstrap().catch((err) => {
  createLogger().fatal({ err }, 'falha ao iniciar aplicação');
  process.exit(1);
});
