/**
 * Códigos de falha estáveis e legíveis por máquina. Cada um diz ao provedor o que fazer:
 * reenviar, corrigir o payload ou desistir.
 */
export enum FailureCode {
  /** BET maior que o saldo. Desistir ou reenviar depois de um depósito. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão que deixaria o saldo negativo. Exige intervenção: o valor já foi gasto. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** O crédito levaria o saldo acima do limite suportado. Exige intervenção. */
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  /** Moeda da operação diferente da moeda da wallet. Corrigir o payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId não é o dono da wallet. Corrigir o payload. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** A transação referenciada não chegou dentro do prazo. Reenviar a referência e depois esta. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência é de outro player, wallet, moeda ou rodada. Corrigir o payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** O tipo da referência não pode ser revertido por esta operação. Corrigir o payload. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência terminou rejeitada ou falhou; não há o que reverter. Desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor diferente do valor da referência (reversão parcial não é suportada). Corrigir. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida. Desistir. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Erro permanente de infraestrutura ao reprocessar. Exige intervenção. */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}
