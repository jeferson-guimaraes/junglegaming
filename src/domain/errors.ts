/** Base dos erros de domínio. `code` é estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário ou moeda fora do contrato. */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** Operação entre valores de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Moedas diferentes: esperado ${expected}, recebido ${received}`);
  }
}

/** Lançamento do ledger que não respeita as próprias invariantes. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/** Wallet criada com estado inicial inválido. */
export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

/** Movimentação com valor zero ou negativo. */
export class InvalidMovementError extends DomainError {
  readonly code = 'INVALID_MOVEMENT';
}

/** Débito maior que o saldo disponível. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('Saldo insuficiente para o débito');
  }
}

/** Transação que viola o contrato de criação (referência, valor, tipo interno). */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

/** Tentativa de transicionar uma transação a partir de um estado que não permite. Erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly current: string,
    readonly attempted: string,
  ) {
    super(`Transição inválida: ${current} → ${attempted}`);
  }
}
