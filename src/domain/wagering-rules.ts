import { DomainError } from './errors';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './events';
import { FailureCode } from './failure-code';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface ApplyWagerTransactionInput {
  wallet: Wallet;
  /** Transação em PENDING (primeira aplicação) ou PENDING_REFERENCE (nova tentativa). */
  transaction: WagerTransaction;
  /** Transação localizada por (providerId, referenceExternalTransactionId), se existir. */
  reference: WagerTransaction | undefined;
  /** Já existe uma reversão PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
  entryId: string;
  now: Date;
}

export type WagerTransition = 'processed' | 'rejected' | 'pending-reference' | 'still-pending';

export interface WagerOutcome {
  transition: WagerTransition;
  /** Presente somente quando o saldo mudou. */
  ledgerEntry: WalletLedgerEntry | undefined;
}

/** Uso incorreto das regras (outra wallet, estado já terminal, OPENING). Erro de programação. */
export class WageringRulesMisuseError extends DomainError {
  readonly code = 'WAGERING_RULES_MISUSE';
}

/** Tipos que cada operação pode referenciar. */
const REFERENCIAS_PERMITIDAS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Aplica uma transação à wallet segundo as regras de negócio. Função pura de domínio:
 * altera a wallet e a transação em memória e devolve o lançamento, quando houver.
 * Quem chama garante a exclusividade sobre a wallet (lock) e persiste tudo junto.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): WagerOutcome {
  const { wallet, transaction: tx, now } = input;
  // Só vale a referência que a própria transação declarou.
  const reference = tx.referenceExternalTransactionId === undefined ? undefined : input.reference;

  if (tx.walletId !== wallet.id) {
    throw new WageringRulesMisuseError('A transação pertence a outra wallet');
  }
  if (tx.kind === WagerTransactionKind.Opening) {
    throw new WageringRulesMisuseError(
      'OPENING é aplicada na abertura da wallet, não pelas regras',
    );
  }
  if (tx.isTerminal()) {
    throw new WageringRulesMisuseError(`Transação ${tx.status} não pode ser aplicada de novo`);
  }

  const rejeitar = (code: FailureCode): WagerOutcome => {
    tx.reject(code, { observedBalance: wallet.balance, at: now });
    return { transition: 'rejected', ledgerEntry: undefined };
  };

  if (tx.playerId !== wallet.playerId) return rejeitar(FailureCode.WalletPlayerMismatch);
  if (tx.money.currency !== wallet.currency) return rejeitar(FailureCode.CurrencyMismatch);

  if (tx.referenceExternalTransactionId !== undefined) {
    // Referência ausente ou ainda não finalizada: aguarda, pois a entrega pode estar fora de ordem.
    if (!reference?.isTerminal()) {
      return aguardarReferencia(input, rejeitar);
    }
    const falha = validarReferencia(input, reference);
    if (falha) return rejeitar(falha);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed({
      referenceTransactionId: reference?.id,
      observedBalance: wallet.balance,
      at: now,
    });
    return { transition: 'processed', ledgerEntry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = {
    money: tx.money,
    transactionId: tx.id,
    entryId: input.entryId,
    now,
  };
  let ledgerEntry: WalletLedgerEntry;
  if (direction === LedgerDirection.Debit) {
    if (!wallet.canDebit(tx.money)) {
      // Aposta sem saldo e reversão que estouraria o saldo são situações operacionais distintas.
      return rejeitar(
        tx.requiresReference() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds,
      );
    }
    ledgerEntry = wallet.debit(movement);
  } else {
    if (!wallet.canCredit(tx.money)) return rejeitar(FailureCode.BalanceLimitExceeded);
    ledgerEntry = wallet.credit(movement);
  }

  tx.markProcessed({
    referenceTransactionId: reference?.id,
    observedBalance: wallet.balance,
    at: now,
  });
  return { transition: 'processed', ledgerEntry };
}

function aguardarReferencia(
  input: ApplyWagerTransactionInput,
  rejeitar: (code: FailureCode) => WagerOutcome,
): WagerOutcome {
  const { wallet, transaction: tx, now } = input;
  if (tx.status !== WagerTransactionStatus.PendingReference) {
    tx.markPendingReference({ observedBalance: wallet.balance, now });
    return { transition: 'pending-reference', ledgerEntry: undefined };
  }
  if (input.reference) {
    // Existe mas não foi finalizada: não gasta as tentativas reservadas à referência ausente,
    // mas a espera tem prazo total, para não ficar presa em referências em ciclo.
    if (tx.hasExceededReferenceWait(now)) return rejeitar(FailureCode.ReferenceNotFound);
    tx.postponeReferenceRetry(now);
    return { transition: 'still-pending', ledgerEntry: undefined };
  }
  tx.registerReferenceRetry(now);
  if (tx.hasExhaustedReferenceRetries()) {
    return rejeitar(FailureCode.ReferenceNotFound);
  }
  return { transition: 'still-pending', ledgerEntry: undefined };
}

/** Valida uma referência já terminal. Devolve o código de falha, ou undefined se estiver tudo certo. */
function validarReferencia(
  input: ApplyWagerTransactionInput,
  reference: WagerTransaction,
): FailureCode | undefined {
  const tx = input.transaction;

  const mesmoContexto =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;
  if (!mesmoContexto) return FailureCode.ReferenceMismatch;

  if (!REFERENCIAS_PERMITIDAS[tx.kind]?.includes(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
    if (input.referenceAlreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------

export interface EventsForInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  outcome: WagerOutcome;
  /** Fornece um contexto com eventId novo a cada chamada. */
  nextContext: () => EventContext;
}

/** Eventos de integração que o resultado de uma aplicação deve gerar. */
export function eventsFor(input: EventsForInput): IntegrationEvent<unknown>[] {
  const { wallet, transaction, outcome, nextContext } = input;
  switch (outcome.transition) {
    case 'processed': {
      const eventos: IntegrationEvent<unknown>[] = [
        WagerTransactionProcessed.from(transaction, nextContext()),
      ];
      if (outcome.ledgerEntry) {
        eventos.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, nextContext()));
      }
      return eventos;
    }
    case 'rejected':
      return [WagerTransactionRejected.from(transaction, nextContext())];
    case 'pending-reference':
      return [WagerTransactionPendingReference.from(transaction, nextContext())];
    case 'still-pending':
      return [];
  }
}
