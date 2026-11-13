import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMovementError,
  InvalidWalletError,
} from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/** Estado como está na persistência. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados de uma movimentação. Os ids vêm de fora para o domínio continuar determinístico. */
export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  now: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  /** Obrigatório quando o saldo inicial é positivo: identifica a transação OPENING e seu lançamento. */
  opening?: { entryId: string; transactionId: string };
}

/**
 * Aggregate root. Toda mudança de saldo passa por `debit` ou `credit`, que devolvem o
 * lançamento do ledger correspondente — não há como mover saldo sem gerar o lançamento.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já na versão 1. Com saldo inicial positivo, devolve também o lançamento
   * de crédito da abertura; com saldo zero, nenhum lançamento é gerado.
   */
  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    const { id, playerId, initialBalance, now, opening } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('O saldo inicial não pode ser negativo');
    }
    const wallet = new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, now, now);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!opening) {
      throw new InvalidWalletError(
        'Saldo inicial positivo exige a transação de abertura para gerar o lançamento',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from({ amount: state.balance, currency: state.currency }),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Indica se um débito desse valor caberia no saldo, sem alterar nada. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Indica se um crédito desse valor caberia no limite suportado, sem alterar nada. */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    const folga = Money.max(this.currency).subtract(this._balance);
    return !folga.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Único ponto que altera saldo e versão; sempre devolve o lançamento correspondente. */
  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.now,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.now;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMovementError('O valor da movimentação deve ser positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
