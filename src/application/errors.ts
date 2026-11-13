/** Base dos erros da camada de aplicação. `code` é estável e vai para a resposta da API. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada fora do contrato: campo ausente, tipo errado ou formato inválido. */
export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Já existe wallet do player ${playerId} em ${currency}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

/**
 * Falha transitória de infraestrutura (lock não obtido no prazo, banco fora, deadlock).
 * Nada foi gravado; a mesma requisição pode ser reenviada.
 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(readonly reason: string) {
    super('Falha transitória de infraestrutura; tente novamente');
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor() {
    super('Transação não encontrada');
  }
}

/**
 * A idempotency key já foi usada com outro payload, ou o par provider/externalTransactionId
 * já existe sob outra key. Não é replay: o provedor precisa corrigir a requisição.
 */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** O insert da transação bateu numa chave única: outra operação gravou a mesma transação antes. */
export class DuplicateTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_TRANSACTION';

  constructor(readonly constraint: string) {
    super(`Transação duplicada (${constraint})`);
  }
}

/** A wallet mudou entre a leitura e a gravação. Não deve ocorrer sob o lock; tratado como transitório. */
export class ConcurrentUpdateError extends TransientInfrastructureError {
  constructor(walletId: string) {
    super(`versão da wallet ${walletId} mudou`);
  }
}

/** O registro de inbox bateu na chave: outra transação registrou a mesma mensagem antes. */
export class DuplicateInboxMessageError extends ApplicationError {
  readonly code = 'DUPLICATE_INBOX_MESSAGE';

  constructor(messageId: string) {
    super(`Mensagem ${messageId} já registrada`);
  }
}

/** O mesmo messageId chegou de novo com outro conteúdo. Erro permanente: a mensagem vai para a DLQ. */
export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';

  constructor(messageId: string) {
    super(`Mensagem ${messageId} reenviada com conteúdo diferente`);
  }
}
