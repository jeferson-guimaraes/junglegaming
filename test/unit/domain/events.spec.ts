import { describe, expect, it } from 'bun:test';
import {
  type EventContext,
  InvalidEventSourceError,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@/domain/events';
import { FailureCode } from '@/domain/failure-code';
import { Money } from '@/domain/money';
import { WagerTransactionKind as Kind, WagerTransaction } from '@/domain/wager-transaction';
import { Wallet } from '@/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-12T12:00:00.000Z');
const T1 = new Date('2026-11-12T12:00:01.000Z');

const ctx: EventContext = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: T1,
};

function aposta(): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('80.00'),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
  });
}

function rollback(): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-2',
    providerId: 'provider-a',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'provider-a:ext-2',
    payloadHash: 'hash-2',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Rollback,
    money: brl('80.00'),
    referenceExternalTransactionId: 'ext-1',
    createdAt: T0,
  });
}

describe('Eventos de integração', () => {
  it('WalletBalanceChanged carrega o lançamento e a versão da wallet, com valores em string', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      now: T0,
      opening: { entryId: 'entry-0', transactionId: 'tx-open' },
    });
    const entry = wallet.debit({
      money: brl('80.00'),
      transactionId: 'tx-1',
      entryId: 'entry-1',
      now: T1,
    });

    const evento = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(JSON.parse(JSON.stringify(evento))).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-11-12T12:00:01.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('WagerTransactionProcessed descreve a transação aplicada', () => {
    const tx = aposta();
    tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('20.00'), at: T1 });

    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
      balance: { amount: '20.00', currency: 'BRL' },
    });
  });

  it('WagerTransactionRejected inclui o código de falha', () => {
    const tx = aposta();
    tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl('10.00'), at: T1 });

    const json = WagerTransactionRejected.from(tx, ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data).toMatchObject({
      transactionId: 'tx-1',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
  });

  it('WagerTransactionPendingReference informa a referência esperada e a próxima tentativa', () => {
    const tx = rollback();
    tx.markPendingReference({ observedBalance: brl('20.00'), now: T1 });

    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data).toMatchObject({
      transactionId: 'tx-2',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'ext-1',
      nextAttemptAt: '2026-11-12T12:00:06.000Z',
    });
  });

  it('causationId é opcional e some do envelope quando ausente', () => {
    const tx = aposta();
    tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('20.00'), at: T1 });

    const json = WagerTransactionProcessed.from(tx, {
      eventId: 'evt-2',
      correlationId: 'corr-2',
      occurredAt: T1,
    }).toJSON();

    expect(json).not.toHaveProperty('causationId');
  });

  it('o envelope é JSON estável: serializar duas vezes dá o mesmo texto e nenhuma instância de Money vaza', () => {
    const tx = aposta();
    tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('20.00'), at: T1 });
    const evento = WagerTransactionProcessed.from(tx, ctx);

    const texto = JSON.stringify(evento);

    expect(JSON.stringify(evento)).toBe(texto);
    expect(JSON.parse(texto)).toEqual(evento.toJSON());
    expect(evento.data.money).not.toBeInstanceOf(Money);
  });

  it('eventos de transação exigem o estado correspondente', () => {
    expect(() => WagerTransactionProcessed.from(aposta(), ctx)).toThrow(InvalidEventSourceError);
    expect(() => WagerTransactionRejected.from(aposta(), ctx)).toThrow(InvalidEventSourceError);
    expect(() => WagerTransactionPendingReference.from(aposta(), ctx)).toThrow(
      InvalidEventSourceError,
    );
  });

  it('o estado é conferido mesmo quando a transação já tem saldo observado', () => {
    const rejeitada = aposta();
    rejeitada.reject(FailureCode.InsufficientFunds, { observedBalance: brl('1.00'), at: T1 });

    expect(() => WagerTransactionProcessed.from(rejeitada, ctx)).toThrow(InvalidEventSourceError);
    expect(() => WagerTransactionPendingReference.from(rejeitada, ctx)).toThrow(
      InvalidEventSourceError,
    );
  });
});
