import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@/domain/failure-code';
import { Money } from '@/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from '@/domain/wager-transaction';
import {
  applyWagerTransaction,
  eventsFor,
  WageringRulesMisuseError,
  type WagerOutcome,
} from '@/domain/wagering-rules';
import { Wallet } from '@/domain/wallet';
import { LedgerDirection } from '@/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-12T12:00:00.000Z');
const T1 = new Date('2026-11-12T12:00:10.000Z');

function wallet(saldo: string, playerId = 'player-1'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId,
    currency: 'BRL',
    balance: saldo,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

let sequencia = 0;
function tx(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  sequencia += 1;
  const exigeReferencia = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create({
    id: `tx-${sequencia}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequencia}`,
    idempotencyKey: `provider-a:ext-${sequencia}`,
    payloadHash: `hash-${sequencia}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('80.00'),
    referenceExternalTransactionId: exigeReferencia ? 'ext-ref' : undefined,
    createdAt: T0,
    ...overrides,
  });
}

/** Uma transação já PROCESSED, para servir de referência. */
function processada(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const t = tx(kind, { externalTransactionId: 'ext-ref', ...overrides });
  t.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('0.00'), at: T0 });
  return t;
}

function aplicar(
  w: Wallet,
  t: WagerTransaction,
  extra: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean; now?: Date } = {},
): WagerOutcome {
  return applyWagerTransaction({
    wallet: w,
    transaction: t,
    reference: extra.reference,
    referenceAlreadyReversed: extra.referenceAlreadyReversed ?? false,
    entryId: 'entry-1',
    now: extra.now ?? T1,
  });
}

function esperarRejeicao(w: Wallet, t: WagerTransaction, outcome: WagerOutcome, code: FailureCode) {
  expect(outcome.transition).toBe('rejected');
  expect(outcome.ledgerEntry).toBeUndefined();
  expect(t.status).toBe(Status.Rejected);
  expect(t.failureCode).toBe(code);
  expect(t.observedBalance?.equals(w.balance)).toBe(true);
}

describe('Regras de transação', () => {
  describe('BET', () => {
    it('debita o saldo e gera um lançamento DEBIT', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet);

      const outcome = aplicar(w, t);

      expect(outcome.transition).toBe('processed');
      expect(t.status).toBe(Status.Processed);
      expect(w.balance.toJSON().amount).toBe('20.00');
      expect(w.version).toBe(2);
      expect(outcome.ledgerEntry).toMatchObject({
        id: 'entry-1',
        transactionId: t.id,
        direction: LedgerDirection.Debit,
      });
      expect(t.observedBalance?.toJSON().amount).toBe('20.00');
      expect(t.processedAt).toEqual(T1);
    });

    it('é rejeitada por saldo insuficiente sem mover saldo nem gerar lançamento', () => {
      const w = wallet('79.99');
      const t = tx(Kind.Bet);

      const outcome = aplicar(w, t);

      esperarRejeicao(w, t, outcome, FailureCode.InsufficientFunds);
      expect(w.balance.toJSON().amount).toBe('79.99');
      expect(w.version).toBe(1);
    });
  });

  describe('WIN', () => {
    it('sem referência credita o saldo com um lançamento CREDIT', () => {
      const w = wallet('20.00');
      const t = tx(Kind.Win, { money: brl('150.00') });

      const outcome = aplicar(w, t);

      expect(outcome.transition).toBe('processed');
      expect(w.balance.toJSON().amount).toBe('170.00');
      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(t.referenceTransactionId).toBeUndefined();
    });

    it('com referência a uma BET processada credita e guarda a referência resolvida', () => {
      const w = wallet('20.00');
      const bet = processada(Kind.Bet);
      const t = tx(Kind.Win, { money: brl('150.00'), referenceExternalTransactionId: 'ext-ref' });

      const outcome = aplicar(w, t, { reference: bet });

      expect(outcome.transition).toBe('processed');
      expect(t.referenceTransactionId).toBe(bet.id);
      expect(w.balance.toJSON().amount).toBe('170.00');
    });

    it('o valor do WIN não precisa ser igual ao da BET', () => {
      const w = wallet('0.00');
      const bet = processada(Kind.Bet, { money: brl('10.00') });
      const t = tx(Kind.Win, { money: brl('500.00'), referenceExternalTransactionId: 'ext-ref' });

      expect(aplicar(w, t, { reference: bet }).transition).toBe('processed');
    });

    it('que levaria o saldo acima do limite suportado é rejeitado, sem mover saldo', () => {
      const w = wallet('99999999999999999.99');
      const t = tx(Kind.Win, { money: brl('0.01') });

      esperarRejeicao(w, t, aplicar(w, t), FailureCode.BalanceLimitExceeded);
      expect(w.balance.toJSON().amount).toBe('99999999999999999.99');
      expect(w.version).toBe(1);
    });

    it('que leva o saldo exatamente ao limite é aceito', () => {
      const w = wallet('99999999999999999.98');
      const t = tx(Kind.Win, { money: brl('0.01') });

      expect(aplicar(w, t).transition).toBe('processed');
      expect(w.balance.toJSON().amount).toBe('99999999999999999.99');
    });

    it('só pode referenciar BET', () => {
      const w = wallet('20.00');
      const outroWin = processada(Kind.Win);
      const t = tx(Kind.Win, { referenceExternalTransactionId: 'ext-ref' });

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: outroWin }),
        FailureCode.ReferenceKindNotAllowed,
      );
    });
  });

  describe('LOSS', () => {
    it('é processada sem mover saldo, sem lançamento e sem mudar a versão', () => {
      const w = wallet('20.00');
      const t = tx(Kind.Loss, { money: brl('0.00') });

      const outcome = aplicar(w, t);

      expect(outcome.transition).toBe('processed');
      expect(outcome.ledgerEntry).toBeUndefined();
      expect(t.status).toBe(Status.Processed);
      expect(w.balance.toJSON().amount).toBe('20.00');
      expect(w.version).toBe(1);
      expect(t.observedBalance?.toJSON().amount).toBe('20.00');
    });
  });

  describe.each([Kind.Win, Kind.Loss])('referência opcional a uma BET (%s)', (kind) => {
    const comReferencia = () => tx(kind, { referenceExternalTransactionId: 'ext-ref' });

    it('BET processada é aceita e a referência resolvida fica gravada', () => {
      const w = wallet('20.00');
      const bet = processada(Kind.Bet);
      const t = comReferencia();

      expect(aplicar(w, t, { reference: bet }).transition).toBe('processed');
      expect(t.referenceTransactionId).toBe(bet.id);
    });

    it.each([Kind.Win, Kind.Loss])('não pode referenciar %s', (tipoDaReferencia) => {
      const w = wallet('20.00');
      const t = comReferencia();

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(tipoDaReferencia) }),
        FailureCode.ReferenceKindNotAllowed,
      );
    });

    it.each([
      ['outro player', { playerId: 'player-2' }],
      ['outra wallet', { walletId: 'wallet-2' }],
      ['outra rodada', { roundId: 'round-2' }],
      ['outra moeda', { money: Money.from({ amount: '80.00', currency: 'USD' }) }],
    ])('BET de %s é rejeitada', (_caso, diferenca) => {
      const w = wallet('20.00');
      const t = comReferencia();

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(Kind.Bet, diferenca) }),
        FailureCode.ReferenceMismatch,
      );
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    it('BET rejeitada não serve de referência', () => {
      const w = wallet('20.00');
      const bet = tx(Kind.Bet, { externalTransactionId: 'ext-ref' });
      bet.reject(FailureCode.InsufficientFunds, { observedBalance: brl('0.00'), at: T0 });
      const t = comReferencia();

      esperarRejeicao(w, t, aplicar(w, t, { reference: bet }), FailureCode.ReferenceNotProcessed);
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    it('sem referência declarada, uma transação passada como referência é ignorada', () => {
      const w = wallet('20.00');
      const t = tx(kind);

      const outcome = aplicar(w, t, { reference: processada(Kind.Bet, { roundId: 'round-2' }) });

      expect(outcome.transition).toBe('processed');
      expect(t.referenceTransactionId).toBeUndefined();
    });
  });

  describe('REFUND', () => {
    it('credita o valor de uma BET processada', () => {
      const w = wallet('20.00');
      const bet = processada(Kind.Bet);
      const t = tx(Kind.Refund);

      const outcome = aplicar(w, t, { reference: bet });

      expect(outcome.transition).toBe('processed');
      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(w.balance.toJSON().amount).toBe('100.00');
      expect(t.referenceTransactionId).toBe(bet.id);
    });

    it.each([Kind.Win, Kind.Refund, Kind.Loss])('não pode referenciar %s', (kind) => {
      const w = wallet('20.00');
      const referencia =
        kind === Kind.Refund
          ? processada(kind, { referenceExternalTransactionId: 'ext-outra' })
          : processada(kind);
      const t = tx(Kind.Refund);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: referencia }),
        FailureCode.ReferenceKindNotAllowed,
      );
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    it('que levaria o saldo acima do limite suportado é rejeitado', () => {
      const w = wallet('99999999999999999.99');
      const t = tx(Kind.Refund);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(Kind.Bet) }),
        FailureCode.BalanceLimitExceeded,
      );
    });
  });

  describe('ROLLBACK', () => {
    it('de BET credita o valor apostado', () => {
      const w = wallet('20.00');
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t, { reference: processada(Kind.Bet) });

      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('de WIN debita o prêmio', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t, { reference: processada(Kind.Win) });

      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    it('de REFUND debita o valor reembolsado', () => {
      const w = wallet('100.00');
      const refund = processada(Kind.Refund, { referenceExternalTransactionId: 'ext-bet' });
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t, { reference: refund });

      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    it('que deixaria o saldo negativo é rejeitado com código próprio, diferente do de aposta sem saldo', () => {
      const w = wallet('79.99');
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t, { reference: processada(Kind.Win) });

      esperarRejeicao(w, t, outcome, FailureCode.ReversalWouldOverdraw);
      expect(w.balance.toJSON().amount).toBe('79.99');
    });

    it.each([Kind.Loss, Kind.Rollback])('não pode referenciar %s', (kind) => {
      const w = wallet('100.00');
      const referencia =
        kind === Kind.Rollback
          ? processada(kind, { referenceExternalTransactionId: 'ext-outra' })
          : processada(kind);
      const t = tx(Kind.Rollback);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: referencia }),
        FailureCode.ReferenceKindNotAllowed,
      );
    });
  });

  describe.each([Kind.Refund, Kind.Rollback])('regras comuns de reversão (%s)', (kind) => {
    it('valor diferente do da referência é rejeitado (sem reversão parcial)', () => {
      const w = wallet('100.00');
      const t = tx(kind, { money: brl('79.99') });

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(Kind.Bet) }),
        FailureCode.ReferenceAmountMismatch,
      );
    });

    it('referência já revertida é rejeitada, qualquer que tenha sido o tipo da reversão anterior', () => {
      const w = wallet('100.00');
      const t = tx(kind);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(Kind.Bet), referenceAlreadyReversed: true }),
        FailureCode.ReferenceAlreadyReversed,
      );
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it.each([
      ['outro player', { playerId: 'player-2' }],
      ['outra wallet', { walletId: 'wallet-2' }],
      ['outra rodada', { roundId: 'round-2' }],
      ['outra moeda', { money: Money.from({ amount: '80.00', currency: 'USD' }) }],
    ])('referência de %s é rejeitada', (_caso, diferenca) => {
      const w = wallet('100.00');
      const t = tx(kind);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: processada(Kind.Bet, diferenca) }),
        FailureCode.ReferenceMismatch,
      );
    });

    it.each([
      [
        'REJECTED',
        (r: WagerTransaction) =>
          r.reject(FailureCode.InsufficientFunds, { observedBalance: brl('0.00'), at: T0 }),
      ],
      ['FAILED', (r: WagerTransaction) => r.fail(FailureCode.InfrastructureFailure, T0)],
    ])('referência %s é rejeitada: não há o que reverter', (_estado, terminar) => {
      const w = wallet('100.00');
      const referencia = tx(Kind.Bet, { externalTransactionId: 'ext-ref' });
      terminar(referencia);
      const t = tx(kind);

      esperarRejeicao(
        w,
        t,
        aplicar(w, t, { reference: referencia }),
        FailureCode.ReferenceNotProcessed,
      );
    });
  });

  describe('referência fora de ordem', () => {
    it('referência ausente deixa a transação PENDING_REFERENCE, sem mover saldo', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t);

      expect(outcome.transition).toBe('pending-reference');
      expect(outcome.ledgerEntry).toBeUndefined();
      expect(t.status).toBe(Status.PendingReference);
      expect(t.referenceAttempts).toBe(0);
      expect(w.balance.toJSON().amount).toBe('100.00');
      expect(w.version).toBe(1);
    });

    it('referência que existe mas ainda não foi processada também deixa pendente', () => {
      const w = wallet('100.00');
      const refundPendente = tx(Kind.Refund, {
        externalTransactionId: 'ext-ref',
        referenceExternalTransactionId: 'ext-bet',
      });
      refundPendente.markPendingReference({ observedBalance: brl('100.00'), now: T0 });
      const t = tx(Kind.Rollback);

      const outcome = aplicar(w, t, { reference: refundPendente });

      expect(outcome.transition).toBe('pending-reference');
      expect(t.status).toBe(Status.PendingReference);
    });

    it('referência ainda não finalizada e de outra rodada aguarda: a divergência só é avaliada no estado final', () => {
      const w = wallet('100.00');
      const refundPendente = tx(Kind.Refund, {
        externalTransactionId: 'ext-ref',
        referenceExternalTransactionId: 'ext-bet',
        roundId: 'round-2',
      });
      refundPendente.markPendingReference({ observedBalance: brl('100.00'), now: T0 });
      const t = tx(Kind.Rollback);

      expect(aplicar(w, t, { reference: refundPendente }).transition).toBe('pending-reference');
      expect(t.status).toBe(Status.PendingReference);
      expect(t.failureCode).toBeUndefined();
    });

    it('referência que existe mas não foi finalizada não consome tentativas, por mais que se repita', () => {
      const w = wallet('100.00');
      const refundPendente = tx(Kind.Refund, {
        externalTransactionId: 'ext-ref',
        referenceExternalTransactionId: 'ext-bet',
      });
      refundPendente.markPendingReference({ observedBalance: brl('100.00'), now: T0 });
      const t = tx(Kind.Rollback);
      aplicar(w, t, { reference: refundPendente });

      for (let i = 0; i < 20; i++) {
        expect(aplicar(w, t, { reference: refundPendente, now: T1 }).transition).toBe(
          'still-pending',
        );
      }

      expect(t.status).toBe(Status.PendingReference);
      expect(t.referenceAttempts).toBe(0);
      expect(t.nextReferenceAttemptAt).toEqual(new Date(T1.getTime() + 5000));
    });

    it('a espera por uma referência não finalizada tem prazo: passados 15 minutos, é rejeitada', () => {
      const w = wallet('100.00');
      // Dois ROLLBACKs que se referenciam: nenhum dos dois jamais será finalizado pelo outro.
      const a = tx(Kind.Rollback, {
        externalTransactionId: 'ext-a',
        referenceExternalTransactionId: 'ext-b',
      });
      const b = tx(Kind.Rollback, {
        externalTransactionId: 'ext-b',
        referenceExternalTransactionId: 'ext-a',
      });
      aplicar(w, a, { now: T0 });
      aplicar(w, b, { reference: a, now: T0 });
      const minutos = (n: number) => new Date(T0.getTime() + n * 60_000);

      expect(aplicar(w, a, { reference: b, now: minutos(14) }).transition).toBe('still-pending');
      const outcome = aplicar(w, a, { reference: b, now: minutos(15) });

      esperarRejeicao(w, a, outcome, FailureCode.ReferenceNotFound);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('só a referência ausente consome tentativas', () => {
      const w = wallet('100.00');
      const refundPendente = tx(Kind.Refund, {
        externalTransactionId: 'ext-ref',
        referenceExternalTransactionId: 'ext-bet',
      });
      refundPendente.markPendingReference({ observedBalance: brl('100.00'), now: T0 });
      const t = tx(Kind.Rollback);
      aplicar(w, t);

      aplicar(w, t);
      aplicar(w, t, { reference: refundPendente });
      aplicar(w, t);

      expect(t.referenceAttempts).toBe(2);
    });

    it('WIN com referência ausente também fica pendente', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Win, { referenceExternalTransactionId: 'ext-ref' });

      expect(aplicar(w, t).transition).toBe('pending-reference');
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('nova tentativa sem a referência conta a tentativa e continua pendente', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Rollback);
      aplicar(w, t);

      const outcome = aplicar(w, t, { now: T1 });

      expect(outcome.transition).toBe('still-pending');
      expect(t.status).toBe(Status.PendingReference);
      expect(t.referenceAttempts).toBe(1);
    });

    it('nova tentativa com a referência já processada aplica a transação', () => {
      const w = wallet('20.00');
      const t = tx(Kind.Rollback);
      aplicar(w, t);

      const outcome = aplicar(w, t, { reference: processada(Kind.Bet) });

      expect(outcome.transition).toBe('processed');
      expect(t.status).toBe(Status.Processed);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('esgotadas as tentativas, é rejeitada com REFERENCE_NOT_FOUND', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Rollback);
      aplicar(w, t);

      let outcome: WagerOutcome | undefined;
      for (let i = 0; i < 6; i++) {
        expect(t.status).toBe(Status.PendingReference);
        outcome = aplicar(w, t);
      }

      if (!outcome) throw new Error('sem resultado');
      esperarRejeicao(w, t, outcome, FailureCode.ReferenceNotFound);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });
  });

  describe('validações contra a wallet', () => {
    it('playerId diferente do dono da wallet é rejeitado', () => {
      const w = wallet('100.00', 'outro-player');
      const t = tx(Kind.Bet);

      esperarRejeicao(w, t, aplicar(w, t), FailureCode.WalletPlayerMismatch);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('moeda diferente da moeda da wallet é rejeitada', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet, { money: Money.from({ amount: '10.00', currency: 'USD' }) });

      esperarRejeicao(w, t, aplicar(w, t), FailureCode.CurrencyMismatch);
      expect(t.observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('OPENING não passa pelas regras: o crédito de abertura já foi feito ao abrir a wallet', () => {
      const w = wallet('100.00');
      const abertura = WagerTransaction.opening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('100.00'),
        createdAt: T0,
      });

      expect(() => aplicar(w, abertura)).toThrow(WageringRulesMisuseError);
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    it('transação de outra wallet é erro de programação', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet, { walletId: 'wallet-2' });

      expect(() => aplicar(w, t)).toThrow(WageringRulesMisuseError);
    });

    it('transação já terminal não pode ser aplicada de novo', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet);
      aplicar(w, t);

      expect(() => aplicar(w, t)).toThrow(WageringRulesMisuseError);
      expect(w.balance.toJSON().amount).toBe('20.00');
    });
  });

  describe('eventos por resultado', () => {
    let n = 0;
    const contexto = () => ({ eventId: `evt-${++n}`, correlationId: 'corr-1', occurredAt: T1 });
    const tipos = (w: Wallet, t: WagerTransaction, outcome: WagerOutcome) =>
      eventsFor({ wallet: w, transaction: t, outcome, nextContext: contexto }).map(
        (e) => e.eventType,
      );

    it('transação que move saldo: Processed + WalletBalanceChanged', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet);

      expect(tipos(w, t, aplicar(w, t))).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    it('LOSS: só Processed, sem WalletBalanceChanged', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Loss);

      expect(tipos(w, t, aplicar(w, t))).toEqual(['WagerTransactionProcessed']);
    });

    it('rejeição: só Rejected', () => {
      const w = wallet('1.00');
      const t = tx(Kind.Bet);

      expect(tipos(w, t, aplicar(w, t))).toEqual(['WagerTransactionRejected']);
    });

    it('referência ausente: PendingReference uma única vez, não a cada nova tentativa', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Rollback);

      expect(tipos(w, t, aplicar(w, t))).toEqual(['WagerTransactionPendingReference']);
      expect(tipos(w, t, aplicar(w, t))).toEqual([]);
    });

    it('cada evento recebe um eventId próprio', () => {
      const w = wallet('100.00');
      const t = tx(Kind.Bet);

      const eventos = eventsFor({
        wallet: w,
        transaction: t,
        outcome: aplicar(w, t),
        nextContext: contexto,
      });

      expect(new Set(eventos.map((e) => e.eventId)).size).toBe(2);
    });
  });
});
