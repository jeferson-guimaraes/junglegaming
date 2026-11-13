import type { InboxMessage } from '@/domain/inbox-message';
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

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  /** Lança DuplicateTransactionError se a idempotency key ou o par provider/external já existir. */
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * Grava o resultado de uma transação que estava PENDING_REFERENCE. Condicionado a esse
   * status: lança ConcurrentUpdateError se a linha já tiver saído dele.
   */
  updatePending(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** `SELECT … FOR UPDATE`. Sempre depois do lock da wallet (ordem única: wallet → transação). */
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  /** Pendentes de referência com nova tentativa vencida. Leitura sem lock: só candidatas. */
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
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
  /**
   * Trava e devolve um lote de eventos pendentes e vencidos (`FOR UPDATE SKIP LOCKED`):
   * publishers concorrentes pegam lotes disjuntos, sem esperar um pelo outro. Eventos nunca
   * tentados vêm antes dos que estão em nova tentativa.
   */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Grava o resultado da tentativa de publicação (publicado ou reagendado). */
  update(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Lança DuplicateInboxMessageError se a mensagem já foi registrada por outra transação. */
  insert(message: InboxMessage): Promise<void>;
}

/** Destino dos eventos de integração (fila de eventos). */
export abstract class EventPublisher {
  /** Deve ser seguro repetir: o mesmo evento publicado duas vezes carrega o mesmo identificador. */
  abstract publish(message: OutboxMessage): Promise<void>;
}

/** Repositórios presos a uma mesma transação SQL. */
export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Unidade de trabalho: tudo que `work` gravar entra em uma única transação SQL, confirmada
 * só se `work` terminar sem erro. Cada chamada usa um contexto de persistência novo.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
