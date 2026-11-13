import type { EventContext } from '@/domain/events';
import { OutboxMessage } from '@/domain/outbox-message';
import type { WagerTransaction } from '@/domain/wager-transaction';
import { applyWagerTransaction, eventsFor, type WagerOutcome } from '@/domain/wagering-rules';
import type { Wallet } from '@/domain/wallet';
import type { IdGenerator, Repositories } from './ports';

export interface ApplyAndPersistInput {
  /** Wallet já travada (`FOR UPDATE`) na transação SQL corrente. */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** true na primeira aplicação (insert); false no reprocessamento de uma pendente (update). */
  novo: boolean;
  correlationId: string;
  causationId: string | undefined;
  now: Date;
  ids: IdGenerator;
}

/**
 * Passo comum à primeira aplicação e ao reprocessamento: resolve a referência, aplica as
 * regras de domínio e grava transação, saldo, lançamento e eventos na transação SQL corrente.
 */
export async function applyAndPersist(
  { wallets, transactions, ledger, outbox }: Repositories,
  input: ApplyAndPersistInput,
): Promise<WagerOutcome> {
  const { wallet, transaction, now, ids } = input;

  const reference = transaction.referenceExternalTransactionId
    ? await transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      )
    : undefined;
  const referenceAlreadyReversed =
    reference !== undefined &&
    transaction.requiresReference() &&
    (await transactions.hasProcessedReversal(reference.id));

  const versaoAntes = wallet.version;
  const outcome = applyWagerTransaction({
    wallet,
    transaction,
    reference,
    referenceAlreadyReversed,
    entryId: ids.next(),
    now,
  });
  const nextContext = (): EventContext => ({
    eventId: ids.next(),
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: now,
  });
  const eventos = eventsFor({ wallet, transaction, outcome, nextContext });

  if (input.novo) await transactions.insert(transaction);
  else await transactions.updatePending(transaction);
  if (outcome.ledgerEntry) {
    await wallets.update(wallet, versaoAntes);
    await ledger.insert(outcome.ledgerEntry);
  }
  for (const evento of eventos) {
    await outbox.insert(OutboxMessage.enqueue(evento));
  }
  return outcome;
}
