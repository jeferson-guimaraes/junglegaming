import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentCorrelationId } from './correlation';

export type AppLogger = Logger;

/** Token de injeção do logger da aplicação. */
export const APP_LOGGER = Symbol('APP_LOGGER');

interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

/**
 * Logger JSON da aplicação. Toda linha emitida dentro de uma requisição ou mensagem
 * recebe o correlationId do contexto, sem precisar passá-lo adiante manualmente.
 * O pid identifica a instância quando várias réplicas escrevem no mesmo destino.
 * Erros devem ir na chave `err`, que o pino serializa com tipo, mensagem e stack.
 */
export function createLogger(options: LoggerOptions = {}): AppLogger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const correlationId = currentCorrelationId();
        return correlationId ? { correlationId } : {};
      },
    },
    options.destination,
  );
}

/** Faz o NestJS escrever seus próprios logs no mesmo formato JSON. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, context?: string): void {
    this.escrever('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.escrever('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.escrever('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.escrever('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.escrever('trace', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.escrever('fatal', message, context);
  }

  private escrever(
    nivel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    if (message instanceof Error) {
      this.logger[nivel]({ context, err: message }, message.message);
      return;
    }
    const texto = typeof message === 'string' ? message : JSON.stringify(message);
    this.logger[nivel]({ context, ...(stack ? { stack } : {}) }, texto);
  }
}
