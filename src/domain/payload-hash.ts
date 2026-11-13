import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';

/**
 * Campos de negócio que identificam o conteúdo de uma transação. São os mesmos na entrada
 * HTTP e na mensagem SQS; cabeçalho, idempotencyKey, messageId e demais metadados de
 * transporte ficam de fora.
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null | undefined;
}

/** JSON canônico: chaves ordenadas em todos os níveis, sem espaços, sem chaves undefined. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entradas = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([chave, v]) => `${JSON.stringify(chave)}:${canonicalJson(v)}`);
    return `{${entradas.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * payloadHash = SHA-256 (hexadecimal) do JSON canônico do subconjunto de campos de negócio.
 * Mesma idempotency key com hash diferente é conflito, não replay.
 * Lança InvalidMoneyError se o valor ou a moeda forem inválidos.
 */
export function computePayloadHash(payload: PayloadHashFields): string {
  const campos = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    // Passa pelo Money: valor ou moeda fora do contrato não geram hash.
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? undefined,
  };
  return createHash('sha256').update(canonicalJson(campos)).digest('hex');
}
