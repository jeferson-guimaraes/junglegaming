import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidPayloadError,
  NotReadyError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@/application/errors';
import { APP_LOGGER, type AppLogger } from '@/infrastructure/observability/logger';

/** Segundos sugeridos ao cliente antes de reenviar após uma falha transitória. */
const RETRY_AFTER_SEGUNDOS = 1;

interface ErroHttp {
  status: number;
  code: string;
  message: string;
}

/** Cada situação tem um status próprio, igual em todos os endpoints. */
function traduzir(erro: unknown): ErroHttp | undefined {
  if (erro instanceof InvalidPayloadError) return { status: 400, ...corpo(erro) };
  if (erro instanceof WalletNotFoundError) return { status: 404, ...corpo(erro) };
  if (erro instanceof TransactionNotFoundError) return { status: 404, ...corpo(erro) };
  if (erro instanceof IdempotencyConflictError) return { status: 409, ...corpo(erro) };
  if (erro instanceof WalletAlreadyExistsError) return { status: 409, ...corpo(erro) };
  if (erro instanceof TransientInfrastructureError) return { status: 503, ...corpo(erro) };
  if (erro instanceof HttpException) {
    const status = erro.getStatus();
    // Erros do próprio framework: JSON malformado (400), rota inexistente (404) etc.
    const code = status === 400 ? 'INVALID_PAYLOAD' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
    return { status, code, message: erro.message };
  }
  return undefined;
}

function corpo(erro: ApplicationError): { code: string; message: string } {
  return { code: erro.code, message: erro.message };
}

/**
 * O erro cru do driver traz `detail` e, em violação de CHECK, a linha inteira com valores
 * monetários. Para o log vão só os campos que identificam a falha.
 */
function resumo(erro: unknown): Record<string, unknown> {
  if (!(erro instanceof Error)) return { message: String(erro) };
  const { code, constraint, table } = erro as {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
  };
  const doBanco = constraint !== undefined || table !== undefined;
  return {
    type: erro.name,
    ...(doBanco ? {} : { message: erro.message }),
    code,
    constraint,
    table,
    stack: doBanco ? erro.stack?.split('\n').slice(1).join('\n') : erro.stack,
  };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(erro: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const conhecido = traduzir(erro);
    if (erro instanceof NotReadyError) {
      response.status(503).json({ status: 'unavailable', checks: erro.checks });
      return;
    }
    if (erro instanceof TransientInfrastructureError) {
      this.logger.warn({ motivo: erro.reason }, 'falha transitória de infraestrutura');
      response.setHeader('Retry-After', String(RETRY_AFTER_SEGUNDOS));
    }
    if (conhecido) {
      // Recusas (4xx) ficam registradas com o código, sem dados do corpo da requisição.
      if (conhecido.status < 500) {
        this.logger.info({ code: conhecido.code, status: conhecido.status }, 'requisição recusada');
      }
      response.status(conhecido.status).json({ code: conhecido.code, message: conhecido.message });
      return;
    }
    this.logger.error({ err: resumo(erro) }, 'erro não tratado na requisição');
    response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  }
}
