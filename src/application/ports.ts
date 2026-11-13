import type { OutboxMessage } from '@/domain/outbox-message';
import type { WagerTransaction } from '@/domain/wager-transaction';
import type { Wallet } from '@/domain/wallet';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';

/** Relógio. Em teste, é substituído para controlar o tempo de workers e novas tentativas. */
export abstract class ClockPort {
  abstract now(): Date;
}

/** Gerador de identificadores (UUID). */
export abstract class IdGenerator {
  abstract next(): string;
}

export interface WalletRepository {
  /** Lança WalletAlreadyExistsError se já houver wallet do player nessa moeda. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** `SELECT … FOR UPDATE`: serializa todas as operações da mesma wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /**
   * Grava saldo e versão somente se a versão no banco ainda for `expectedVersion`.
   * Lança ConcurrentUpdateError caso contrário.
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** Lança DuplicateTransactionError se a idempotency key ou o par provider/external já existir. */
  insert(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND ou ROLLBACK processado apontando para a transação. */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
}

/** Repositórios presos a uma mesma transação SQL. */
export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Unidade de trabalho: tudo que `work` gravar entra em uma única transação SQL, confirmada
 * só se `work` terminar sem erro. Cada chamada usa um contexto de persistência novo.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
