import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { TransientInfrastructureError, WalletAlreadyExistsError } from '@/application/errors';
import { type Repositories, UnitOfWork } from '@/application/ports';
import {
  ledgerEntryToRecord,
  outboxToRecord,
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
    },
    transactions: {
      async insert(transaction) {
        await em.insert(WagerTransactionRecord, transactionToRecord(transaction));
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
        if (isTransient(erro)) {
          throw new TransientInfrastructureError(String((erro as { code: string }).code));
        }
        throw erro;
      });
  }
}
