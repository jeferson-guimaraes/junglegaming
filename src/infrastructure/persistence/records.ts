import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de persistência: espelham as tabelas e não têm regra de negócio. O domínio não os
 * conhece; a conversão fica nos mapeadores. Valores monetários trafegam como string decimal.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string' },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'Date' },
    updatedAt: { type: 'Date' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedBalanceCurrency!: string | null;
  processedAt!: Date | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text', nullable: true },
    gameId: { type: 'text', nullable: true },
    kind: { type: 'text' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    observedBalance: { type: 'decimal', precision: 19, scale: 2, nullable: true },
    observedBalanceCurrency: { type: 'string', nullable: true },
    processedAt: { type: 'Date', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { type: 'Date', nullable: true },
    createdAt: { type: 'Date' },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    balanceBefore: { type: 'decimal', precision: 19, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 19, scale: 2 },
    createdAt: { type: 'Date' },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', nullable: true },
    publishedAt: { type: 'Date', nullable: true },
  },
});
