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
