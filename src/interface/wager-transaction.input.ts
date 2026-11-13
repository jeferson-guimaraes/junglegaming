import type { WagerTransactionCommand } from '@/application/process-wager-transaction';
import { WagerTransactionKind } from '@/domain/wager-transaction';
import { money, objeto, texto, umDe, uuid } from './validation';

/** Tipos que um provedor pode submeter. OPENING é interno. */
const KINDS_ACEITOS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export type WagerTransactionInput = Omit<WagerTransactionCommand, 'correlationId' | 'causationId'>;

/**
 * Valida os campos de negócio de uma transação. É a mesma função para o corpo HTTP e para o
 * `data` da mensagem de fila: as duas entradas aceitam e rejeitam exatamente as mesmas coisas.
 * Lança InvalidPayloadError.
 */
export function parseWagerTransaction(
  dados: unknown,
  idempotencyKey: unknown,
): WagerTransactionInput {
  const payload = objeto(dados, 'corpo');
  const referencia = payload.referenceExternalTransactionId;
  return {
    idempotencyKey: texto(idempotencyKey, 'Idempotency-Key', 300),
    providerId: texto(payload.providerId, 'providerId'),
    externalTransactionId: texto(payload.externalTransactionId, 'externalTransactionId'),
    playerId: uuid(payload.playerId, 'playerId'),
    walletId: uuid(payload.walletId, 'walletId'),
    roundId: texto(payload.roundId, 'roundId'),
    gameId: texto(payload.gameId, 'gameId'),
    kind: umDe(payload.kind, 'kind', KINDS_ACEITOS),
    money: money(payload.money, 'money'),
    referenceExternalTransactionId:
      referencia === undefined || referencia === null
        ? undefined
        : texto(referencia, 'referenceExternalTransactionId'),
  };
}
