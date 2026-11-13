import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  ConcurrentUpdateError,
  DuplicateTransactionError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '@/application/errors';
import { type Repositories, UnitOfWork } from '@/application/ports';
import type { WagerTransaction } from '@/domain/wager-transaction';
import {
  ledgerEntryToRecord,
  outboxToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './records';

/** Nome da constraint violada, quando o erro é de chave única. */
function uniqueViolada(erro: unknown): string | undefined {
  if (!(erro instanceof UniqueConstraintViolationException)) return undefined;
  return (erro as { constraint?: string }).constraint;
}

/**
 * Códigos que indicam falha transitória: nada foi gravado e vale tentar de novo. A
 * classificação é pelo código do PostgreSQL ou do socket, porque o MikroORM não converte
 * todos em exceções próprias (lock_timeout chega como DriverException genérica e banco fora
 * chega como Error puro).
 */
const TRANSITORIOS = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

export function isTransient(erro: unknown): boolean {
  const code = (erro as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return TRANSITORIOS.has(code) || code.startsWith('08'); // 08xxx: exceções de conexão
}

/**
 * Índice único da reversão única. Sob o lock da wallet a regra de domínio rejeita antes;
 * se mesmo assim o banco barrar, nada foi gravado e a operação é tratada como transitória.
 */
const REVERSAO_UNICA = 'wager_transactions_single_reversal';

async function umaTransacao(
  em: EntityManager,
  where: Partial<WagerTransactionRecord>,
): Promise<WagerTransaction | undefined> {
  const record = await em.findOne(WagerTransactionRecord, where);
  return record ? transactionFromRecord(record) : undefined;
}

/**
 * Repositórios presos ao EntityManager de uma transação. Cada escrita é um comando SQL
 * imediato (sem unit of work do ORM), então a ordem dos comandos é a ordem do código.
 */
function repositories(em: EntityManager): Repositories {
  return {
    wallets: {
      async insert(wallet) {
        try {
          await em.insert(WalletRecord, walletToRecord(wallet));
        } catch (erro) {
          if (uniqueViolada(erro) === 'wallets_player_currency_unique') {
            throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
          }
          throw erro;
        }
      },
      async findById(id) {
        const record = await em.findOne(WalletRecord, { id });
        return record ? walletFromRecord(record) : undefined;
      },
      async findByIdForUpdate(id) {
        const record = await em.findOne(
          WalletRecord,
          { id },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        return record ? walletFromRecord(record) : undefined;
      },
      async update(wallet, expectedVersion) {
        const alteradas = await em.nativeUpdate(
          WalletRecord,
          { id: wallet.id, version: expectedVersion },
          {
            balance: wallet.balance.toJSON().amount,
            version: wallet.version,
            updatedAt: wallet.updatedAt,
          },
        );
        if (alteradas !== 1) throw new ConcurrentUpdateError(wallet.id);
      },
    },
    transactions: {
      async insert(transaction) {
        try {
          await em.insert(WagerTransactionRecord, transactionToRecord(transaction));
        } catch (erro) {
          const constraint = uniqueViolada(erro);
          if (
            constraint === 'wager_transactions_idempotency_key_unique' ||
            constraint === 'wager_transactions_provider_external_unique'
          ) {
            throw new DuplicateTransactionError(constraint);
          }
          if (constraint === REVERSAO_UNICA) throw new ConcurrentUpdateError(transaction.walletId);
          throw erro;
        }
      },
      async updatePending(transaction) {
        const { id: _id, ...campos } = transactionToRecord(transaction);
        let alteradas: number;
        try {
          alteradas = await em.nativeUpdate(
            WagerTransactionRecord,
            { id: transaction.id, status: 'PENDING_REFERENCE' },
            {
              status: campos.status,
              failureCode: campos.failureCode,
              referenceTransactionId: campos.referenceTransactionId,
              observedBalance: campos.observedBalance,
              observedBalanceCurrency: campos.observedBalanceCurrency,
              processedAt: campos.processedAt,
              referenceAttempts: campos.referenceAttempts,
              nextReferenceAttemptAt: campos.nextReferenceAttemptAt,
            },
          );
        } catch (erro) {
          if (uniqueViolada(erro) === REVERSAO_UNICA) {
            throw new ConcurrentUpdateError(transaction.walletId);
          }
          throw erro;
        }
        if (alteradas !== 1) throw new ConcurrentUpdateError(transaction.walletId);
      },
      async findById(id) {
        return umaTransacao(em, { id });
      },
      async findByIdForUpdate(id) {
        const record = await em.findOne(
          WagerTransactionRecord,
          { id },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        return record ? transactionFromRecord(record) : undefined;
      },
      async findDuePendingReferences(now, limit) {
        const records = await em.find(
          WagerTransactionRecord,
          { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
          { orderBy: { nextReferenceAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
        );
        return records.map((record) => ({ id: record.id, walletId: record.walletId }));
      },
      async findByIdempotencyKey(idempotencyKey) {
        return umaTransacao(em, { idempotencyKey });
      },
      async findByExternalId(providerId, externalTransactionId) {
        return umaTransacao(em, { providerId, externalTransactionId });
      },
      async hasProcessedReversal(transactionId) {
        const quantidade = await em.count(WagerTransactionRecord, {
          referenceTransactionId: transactionId,
          status: 'PROCESSED',
          kind: { $in: ['REFUND', 'ROLLBACK'] },
        });
        return quantidade > 0;
      },
    },
    ledger: {
      async insert(entry) {
        await em.insert(LedgerEntryRecord, ledgerEntryToRecord(entry));
      },
    },
    outbox: {
      async insert(message) {
        await em.insert(OutboxRecord, outboxToRecord(message));
      },
    },
  };
}

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // EntityManager novo a cada chamada: nenhum estado em memória passa de uma operação a outra.
    return this.orm.em
      .fork()
      .transactional((em) => work(repositories(em)))
      .catch((erro: unknown) => {
        if (erro instanceof TransientInfrastructureError) throw erro;
        if (isTransient(erro)) {
          throw new TransientInfrastructureError(String((erro as { code: string }).code));
        }
        throw erro;
      });
  }
}
