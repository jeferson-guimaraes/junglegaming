import { describe, expect, it } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '@/domain/errors';
import { FailureCode } from '@/domain/failure-code';
import { Money } from '@/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  REFERENCE_RETRY_POLICY,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from '@/domain/wager-transaction';
import { LedgerDirection } from '@/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-12T12:00:00.000Z');
const T1 = new Date('2026-11-12T12:00:01.000Z');
const segundosDepois = (base: Date, s: number) => new Date(base.getTime() + s * 1000);

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
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
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
    ...overrides,
  };
}

const criar = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

const reversao = (kind: Kind.Refund | Kind.Rollback) =>
  criar({ kind, referenceExternalTransactionId: 'ext-0' });

describe('WagerTransaction', () => {
  describe('criação', () => {
    it('nasce PENDING, sem resultado', () => {
      const tx = criar();

      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.failureCode).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.referenceTransactionId).toBeUndefined();
      expect(tx.observedBalance).toBeUndefined();
    });

    it.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
      expect(() => criar({ kind })).toThrow(InvalidTransactionError);
      expect(reversao(kind as Kind.Refund | Kind.Rollback).requiresReference()).toBe(true);
    });

    it.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
      expect(criar({ kind }).requiresReference()).toBe(false);
      expect(
        criar({ kind, referenceExternalTransactionId: 'ext-0' }).referenceExternalTransactionId,
      ).toBe('ext-0');
    });

    it('BET não pode carregar referência', () => {
      expect(() => criar({ referenceExternalTransactionId: 'ext-0' })).toThrow(
        InvalidTransactionError,
      );
    });

    it.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
      '%s com referência vazia é inválida',
      (kind) => {
        expect(() => criar({ kind, referenceExternalTransactionId: '' })).toThrow(
          InvalidTransactionError,
        );
      },
    );

    it('o provedor interno é reservado para a abertura de wallet', () => {
      expect(() => criar({ providerId: 'internal' })).toThrow(InvalidTransactionError);
    });

    it('não pode referenciar a si mesma', () => {
      expect(() => criar({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-1' })).toThrow(
        InvalidTransactionError,
      );
    });

    it('OPENING não pode ser submetida de fora', () => {
      expect(() => criar({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
    });

    it.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])(
      '%s com valor zero é inválida',
      (kind) => {
        const referencia = kind === Kind.Refund || kind === Kind.Rollback ? 'ext-0' : undefined;

        expect(() =>
          criar({ kind, money: brl('0.00'), referenceExternalTransactionId: referencia }),
        ).toThrow(InvalidTransactionError);
      },
    );

    it('LOSS aceita valor zero', () => {
      expect(criar({ kind: Kind.Loss, money: brl('0.00') }).status).toBe(Status.Pending);
    });

    it('valor negativo é inválido', () => {
      expect(() => criar({ money: brl('1.00').negate() })).toThrow(InvalidTransactionError);
    });
  });

  describe('abertura interna', () => {
    it('opening cria a transação OPENING com identificadores sintéticos', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        createdAt: T0,
      });

      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.status).toBe(Status.Pending);
      expect(tx.providerId).toBe('internal');
      expect(tx.externalTransactionId).toBe('wallet-1');
      expect(tx.idempotencyKey).toBe('opening:wallet-1');
      expect(tx.roundId).toBeUndefined();
      expect(tx.gameId).toBeUndefined();
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('abertura com valor zero é inválida (saldo zero não gera transação)', () => {
      expect(() =>
        WagerTransaction.opening({
          id: 'tx-open',
          walletId: 'w',
          playerId: 'p',
          money: brl('0.00'),
          createdAt: T0,
        }),
      ).toThrow(InvalidTransactionError);
    });
  });

  describe('transições', () => {
    it('PENDING → PROCESSED guarda referência resolvida, saldo observado e data', () => {
      const tx = reversao(Kind.Refund);

      tx.markProcessed({ referenceTransactionId: 'tx-0', observedBalance: brl('100.00'), at: T1 });

      expect(tx.status).toBe(Status.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.referenceTransactionId).toBe('tx-0');
      expect(tx.observedBalance?.toJSON().amount).toBe('100.00');
      expect(tx.processedAt).toEqual(T1);
      expect(tx.failureCode).toBeUndefined();
    });

    it('PENDING → REJECTED guarda o código, o saldo observado e a data', () => {
      const tx = criar();

      tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl('10.00'), at: T1 });

      expect(tx.status).toBe(Status.Rejected);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.observedBalance?.toJSON().amount).toBe('10.00');
      expect(tx.processedAt).toEqual(T1);
    });

    it('PENDING → FAILED guarda o código e a data', () => {
      const tx = criar();

      tx.fail(FailureCode.InfrastructureFailure, T1);

      expect(tx.status).toBe(Status.Failed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.failureCode).toBe(FailureCode.InfrastructureFailure);
    });

    it('PENDING → PENDING_REFERENCE agenda a primeira nova tentativa', () => {
      const tx = reversao(Kind.Rollback);

      tx.markPendingReference({ observedBalance: brl('50.00'), now: T0 });

      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.referenceAttempts).toBe(0);
      expect(tx.nextReferenceAttemptAt).toEqual(
        segundosDepois(T0, REFERENCE_RETRY_POLICY.baseDelaySeconds),
      );
      expect(tx.observedBalance?.toJSON().amount).toBe('50.00');
    });

    it.each([
      [
        'PROCESSED',
        (tx: WagerTransaction) =>
          tx.markProcessed({
            referenceTransactionId: 'tx-0',
            observedBalance: brl('1.00'),
            at: T1,
          }),
      ],
      [
        'REJECTED',
        (tx: WagerTransaction) =>
          tx.reject(FailureCode.ReferenceNotFound, { observedBalance: brl('1.00'), at: T1 }),
      ],
      ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T1)],
    ])('PENDING_REFERENCE → %s é permitida', (esperado, transicionar) => {
      const tx = reversao(Kind.Rollback);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });

      transicionar(tx);

      expect(tx.status).toBe(esperado as Status);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it('PENDING_REFERENCE não volta a PENDING_REFERENCE: as tentativas não são zeradas', () => {
      const tx = reversao(Kind.Rollback);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });
      tx.registerReferenceRetry(T0);
      tx.registerReferenceRetry(T0);

      expect(() => tx.markPendingReference({ observedBalance: brl('1.00'), now: T1 })).toThrow(
        InvalidTransactionStateError,
      );
      expect(tx.referenceAttempts).toBe(2);
    });

    it('REJECTED é para regra de negócio e FAILED para infraestrutura: os códigos não se misturam', () => {
      expect(() =>
        criar().reject(FailureCode.InfrastructureFailure, {
          observedBalance: brl('1.00'),
          at: T1,
        }),
      ).toThrow(InvalidTransactionError);
      expect(() => criar().fail(FailureCode.InsufficientFunds, T1)).toThrow(
        InvalidTransactionError,
      );
    });

    it('estado terminal não aceita nenhuma transição', () => {
      const terminais = [
        (tx: WagerTransaction) =>
          tx.markProcessed({
            referenceTransactionId: undefined,
            observedBalance: brl('1.00'),
            at: T1,
          }),
        (tx: WagerTransaction) =>
          tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl('1.00'), at: T1 }),
        (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T1),
      ];
      const todas = [
        ...terminais,
        (tx: WagerTransaction) =>
          tx.markPendingReference({ observedBalance: brl('1.00'), now: T1 }),
        (tx: WagerTransaction) => tx.registerReferenceRetry(T1),
      ];

      for (const chegarAoTerminal of terminais) {
        for (const tentar of todas) {
          const tx = criar();
          chegarAoTerminal(tx);
          const antes = tx.status;

          expect(() => tentar(tx)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(antes);
        }
      }
    });
  });

  describe('novas tentativas de referência', () => {
    it('o intervalo dobra a cada tentativa', () => {
      const tx = reversao(Kind.Refund);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });
      const base = REFERENCE_RETRY_POLICY.baseDelaySeconds;

      tx.registerReferenceRetry(T0);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toEqual(segundosDepois(T0, base * 2));

      tx.registerReferenceRetry(T0);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.nextReferenceAttemptAt).toEqual(segundosDepois(T0, base * 4));
    });

    it('a política é de 6 esperas: 5, 10, 20, 40, 80 e 160 segundos', () => {
      const tx = reversao(Kind.Refund);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });
      const esperas = [tx.nextReferenceAttemptAt];

      for (let i = 0; i < 5; i++) {
        tx.registerReferenceRetry(T0);
        expect(tx.hasExhaustedReferenceRetries()).toBe(false);
        esperas.push(tx.nextReferenceAttemptAt);
      }
      tx.registerReferenceRetry(T0);

      expect(esperas).toEqual([5, 10, 20, 40, 80, 160].map((s) => segundosDepois(T0, s)));
      expect(tx.hasExhaustedReferenceRetries()).toBe(true);
      expect(tx.referenceAttempts).toBe(6);
    });

    it('esgota após o número máximo de tentativas', () => {
      const tx = reversao(Kind.Refund);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });

      for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts - 1; i++) {
        tx.registerReferenceRetry(T0);
        expect(tx.hasExhaustedReferenceRetries()).toBe(false);
      }
      tx.registerReferenceRetry(T0);

      expect(tx.hasExhaustedReferenceRetries()).toBe(true);
    });

    it('isReferenceRetryDue respeita o horário agendado', () => {
      const tx = reversao(Kind.Refund);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });
      const agendado = segundosDepois(T0, REFERENCE_RETRY_POLICY.baseDelaySeconds);

      expect(tx.isReferenceRetryDue(segundosDepois(agendado, -1))).toBe(false);
      expect(tx.isReferenceRetryDue(agendado)).toBe(true);
    });

    it('postponeReferenceRetry reagenda com o intervalo atual, sem contar tentativa', () => {
      const tx = reversao(Kind.Refund);
      tx.markPendingReference({ observedBalance: brl('1.00'), now: T0 });
      tx.registerReferenceRetry(T0);

      tx.postponeReferenceRetry(T1);
      tx.postponeReferenceRetry(T1);

      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toEqual(segundosDepois(T1, 10));
      expect(() => criar().postponeReferenceRetry(T0)).toThrow(InvalidTransactionStateError);
    });

    it('só existe em PENDING_REFERENCE', () => {
      expect(() => criar().registerReferenceRetry(T0)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('consultas de domínio', () => {
    it('affectsBalance é falso apenas para LOSS', () => {
      expect(criar({ kind: Kind.Loss }).affectsBalance()).toBe(false);
      expect(criar({ kind: Kind.Bet }).affectsBalance()).toBe(true);
      expect(criar({ kind: Kind.Win }).affectsBalance()).toBe(true);
      expect(reversao(Kind.Refund).affectsBalance()).toBe(true);
      expect(reversao(Kind.Rollback).affectsBalance()).toBe(true);
    });

    it('matchesPayload compara o hash do payload', () => {
      const tx = criar({ payloadHash: 'abc' });

      expect(tx.matchesPayload('abc')).toBe(true);
      expect(tx.matchesPayload('abd')).toBe(false);
    });

    it('direção do ledger por tipo', () => {
      expect(criar({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(criar({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(reversao(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('ROLLBACK inverte a direção da transação referenciada', () => {
      const rollback = reversao(Kind.Rollback);
      const bet = criar({ kind: Kind.Bet });
      const win = criar({ kind: Kind.Win });
      const refund = reversao(Kind.Refund);

      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    });

    it('ROLLBACK sem a referência e LOSS não têm direção', () => {
      expect(() => reversao(Kind.Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionError);
      expect(() => criar({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
        InvalidTransactionError,
      );
    });
  });

  describe('reidratação', () => {
    it('reconstrói um estado terminal sem revalidar transições', () => {
      const tx = WagerTransaction.rehydrate({
        id: 'tx-9',
        providerId: 'provider-a',
        externalTransactionId: 'ext-9',
        idempotencyKey: 'provider-a:ext-9',
        payloadHash: 'hash-9',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: Kind.Rollback,
        amount: '25.00',
        currency: 'BRL',
        referenceExternalTransactionId: 'ext-0',
        createdAt: T0,
        status: Status.Rejected,
        referenceTransactionId: 'tx-0',
        failureCode: FailureCode.ReversalWouldOverdraw,
        observedBalance: { amount: '5.00', currency: 'BRL' },
        processedAt: T1,
        referenceAttempts: 3,
        nextReferenceAttemptAt: undefined,
      });

      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
      expect(tx.money.toJSON().amount).toBe('25.00');
      expect(tx.observedBalance?.toJSON().amount).toBe('5.00');
      expect(tx.referenceAttempts).toBe(3);
      expect(tx.isTerminal()).toBe(true);
    });

    it('o saldo observado mantém a moeda da wallet, mesmo diferente da moeda da transação', () => {
      const original = criar({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
      original.reject(FailureCode.CurrencyMismatch, { observedBalance: brl('100.00'), at: T1 });

      const tx = WagerTransaction.rehydrate({
        id: original.id,
        providerId: original.providerId,
        externalTransactionId: original.externalTransactionId,
        idempotencyKey: original.idempotencyKey,
        payloadHash: original.payloadHash,
        walletId: original.walletId,
        playerId: original.playerId,
        roundId: original.roundId,
        gameId: original.gameId,
        kind: original.kind,
        amount: '10.00',
        currency: 'USD',
        referenceExternalTransactionId: undefined,
        createdAt: T0,
        status: Status.Rejected,
        referenceTransactionId: undefined,
        failureCode: FailureCode.CurrencyMismatch,
        observedBalance: original.observedBalance?.toJSON(),
        processedAt: T1,
        referenceAttempts: 0,
        nextReferenceAttemptAt: undefined,
      });

      expect(tx.observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(tx.money.toJSON()).toEqual({ amount: '10.00', currency: 'USD' });
    });
  });
});
