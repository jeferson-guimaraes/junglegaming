import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/** Executa `fn` com o correlationId disponível para tudo que rodar dentro dela, inclusive de forma assíncrona. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function newCorrelationId(): string {
  return Bun.randomUUIDv7();
}

/** Entrada HTTP: reaproveita o cabeçalho do chamador ou gera um identificador novo. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const recebido = req.header(CORRELATION_HEADER);
  const correlationId = recebido && recebido.length <= 128 ? recebido : newCorrelationId();
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelation(correlationId, next);
}
