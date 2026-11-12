import type { AppLogger } from '../observability/logger';

interface GracefulShutdownInput {
  signal: string;
  /** Fecha a aplicação (servidor HTTP, consumidores, conexões). */
  close: (signal: string) => Promise<void>;
  logger: AppLogger;
  /** Prazo máximo. Deve ficar abaixo do tempo que o orquestrador espera antes do SIGKILL. */
  timeoutMs: number;
}

const PRAZO_ESGOTADO = Symbol('prazo esgotado');

/**
 * Encerra a aplicação e devolve o código de saída do processo.
 * Nunca fica esperando para sempre: passado o prazo, registra e desiste.
 */
export async function gracefulShutdown(input: GracefulShutdownInput): Promise<0 | 1> {
  const { signal, close, logger, timeoutMs } = input;
  logger.info({ sinal: signal }, 'encerrando aplicação');

  let prazo: ReturnType<typeof setTimeout> | undefined;
  try {
    const resultado = await Promise.race([
      close(signal),
      new Promise<typeof PRAZO_ESGOTADO>((resolve) => {
        prazo = setTimeout(() => resolve(PRAZO_ESGOTADO), timeoutMs);
      }),
    ]);
    if (resultado === PRAZO_ESGOTADO) {
      logger.error({ timeoutMs }, 'prazo de encerramento esgotado');
      return 1;
    }
    logger.info('aplicação encerrada');
    return 0;
  } catch (err) {
    logger.error({ err }, 'falha ao encerrar aplicação');
    return 1;
  } finally {
    clearTimeout(prazo);
  }
}
