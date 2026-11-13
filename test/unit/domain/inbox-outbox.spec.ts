import { describe, expect, it } from 'bun:test';
import { type EventContext, WagerTransactionProcessed } from '@/domain/events';
import { InboxMessage } from '@/domain/inbox-message';
import { Money } from '@/domain/money';
import { OUTBOX_RETRY_POLICY, OutboxMessage } from '@/domain/outbox-message';
import { WagerTransactionKind as Kind, WagerTransaction } from '@/domain/wager-transaction';

const T0 = new Date('2026-11-12T12:00:00.000Z');
const T1 = new Date('2026-11-12T12:00:01.000Z');
const segundosDepois = (base: Date, s: number) => new Date(base.getTime() + s * 1000);

function evento(): WagerTransactionProcessed {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Loss,
    money: Money.from({ amount: '0.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
  });
  tx.markProcessed({
    referenceTransactionId: undefined,
    observedBalance: Money.from({ amount: '5.00', currency: 'BRL' }),
    at: T0,
  });
  const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 };
  return WagerTransactionProcessed.from(tx, ctx);
}

describe('InboxMessage', () => {
  it('receive registra a mensagem ainda não processada', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'hash-1',
      receivedAt: T0,
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });

  it('markProcessed registra quando foi processada e não muda depois', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'hash-1',
      receivedAt: T0,
    });

    inbox.markProcessed(T1);
    inbox.markProcessed(segundosDepois(T1, 60));

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(T1);
  });

  it('rehydrate reconstrói o estado persistido', () => {
    const inbox = InboxMessage.rehydrate({
      messageId: 'msg-2',
      consumerName: 'wager-transactions',
      payloadHash: 'hash-2',
      receivedAt: T0,
      processedAt: T1,
    });

    expect(inbox.messageId).toBe('msg-2');
    expect(inbox.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  it('enqueue guarda o envelope serializado do evento, pronto para envio', () => {
    const origem = evento();

    const outbox = OutboxMessage.enqueue(origem);

    expect(outbox.id).toBe('evt-1');
    expect(outbox.aggregateId).toBe('wallet-1');
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.occurredAt).toEqual(T0);
    expect(outbox.payload).toEqual(JSON.parse(JSON.stringify(origem)));
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.nextAttemptAt).toEqual(T0);
    expect(outbox.isDue(T0)).toBe(true);
  });

  it('markPublished encerra a pendência', () => {
    const outbox = OutboxMessage.enqueue(evento());

    outbox.markPublished(T1);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(segundosDepois(T1, 3600))).toBe(false);
    expect(outbox.publishedAt).toEqual(T1);
    expect(outbox.nextAttemptAt).toBeUndefined();
  });

  it('markPublished é idempotente: mantém a primeira data de publicação', () => {
    const outbox = OutboxMessage.enqueue(evento());

    outbox.markPublished(T1);
    outbox.markPublished(segundosDepois(T1, 60));

    expect(outbox.publishedAt).toEqual(T1);
  });

  it('scheduleRetry não reabre um evento já publicado', () => {
    const outbox = OutboxMessage.enqueue(evento());
    outbox.markPublished(T1);

    outbox.scheduleRetry(segundosDepois(T1, 5));

    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(outbox.isPending()).toBe(false);
  });

  it('a política é de 1 s dobrando até o teto de 60 s: 1, 2, 4, 8, 16, 32, 60, 60', () => {
    const outbox = OutboxMessage.enqueue(evento());
    const esperas: (Date | undefined)[] = [];

    for (let i = 0; i < 8; i++) {
      outbox.scheduleRetry(T1);
      esperas.push(outbox.nextAttemptAt);
    }

    expect(esperas).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((s) => segundosDepois(T1, s)));
  });

  it('scheduleRetry incrementa as tentativas e dobra o intervalo', () => {
    const outbox = OutboxMessage.enqueue(evento());
    const base = OUTBOX_RETRY_POLICY.baseDelaySeconds;

    outbox.scheduleRetry(T1);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt).toEqual(segundosDepois(T1, base));
    expect(outbox.isDue(T1)).toBe(false);
    expect(outbox.isDue(segundosDepois(T1, base))).toBe(true);

    outbox.scheduleRetry(T1);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt).toEqual(segundosDepois(T1, base * 2));

    outbox.scheduleRetry(T1);
    expect(outbox.nextAttemptAt).toEqual(segundosDepois(T1, base * 4));
  });

  it('o intervalo tem teto e o evento nunca é abandonado', () => {
    const outbox = OutboxMessage.enqueue(evento());

    for (let i = 0; i < 50; i++) outbox.scheduleRetry(T1);

    expect(outbox.attempts).toBe(50);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.nextAttemptAt).toEqual(segundosDepois(T1, OUTBOX_RETRY_POLICY.maxDelaySeconds));
  });

  it('rehydrate reconstrói o estado persistido', () => {
    const outbox = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'wallet-9',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'evt-9' },
      occurredAt: T0,
      attempts: 4,
      nextAttemptAt: T1,
      publishedAt: undefined,
    });

    expect(outbox.attempts).toBe(4);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(T0)).toBe(false);
    expect(outbox.isDue(T1)).toBe(true);
  });
});
