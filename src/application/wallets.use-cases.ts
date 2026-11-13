import { Injectable } from '@nestjs/common';
import {
  type EventContext,
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '@/domain/events';
import type { Money } from '@/domain/money';
import { OutboxMessage } from '@/domain/outbox-message';
import { WagerTransaction } from '@/domain/wager-transaction';
import { Wallet } from '@/domain/wallet';
import { WalletNotFoundError } from './errors';
import { ClockPort, IdGenerator, Metrics, UnitOfWork } from './ports';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

@Injectable()
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  /**
   * Abre a wallet. Com saldo inicial positivo, grava na mesma transação SQL a transação
   * interna OPENING, o lançamento CREDIT e os eventos correspondentes.
   */
  async execute(input: OpenWalletInput): Promise<Wallet> {
    const now = this.clock.now();
    const walletId = this.ids.next();

    if (input.initialBalance.isZero()) {
      const { wallet } = Wallet.open({ ...input, id: walletId, now });
      await this.uow.run(({ wallets }) => wallets.insert(wallet));
      return wallet;
    }

    const opening = WagerTransaction.opening({
      id: this.ids.next(),
      walletId,
      playerId: input.playerId,
      money: input.initialBalance,
      createdAt: now,
    });
    const { wallet, openingEntry } = Wallet.open({
      ...input,
      id: walletId,
      now,
      opening: { entryId: this.ids.next(), transactionId: opening.id },
    });
    if (!openingEntry) throw new Error('Abertura com saldo positivo sem lançamento');
    opening.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: wallet.balance,
      at: now,
    });

    const contexto = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: input.correlationId,
      occurredAt: now,
    });
    const eventos = [
      WagerTransactionProcessed.from(opening, contexto()),
      WalletBalanceChanged.from(wallet, openingEntry, contexto()),
    ];

    await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      await wallets.insert(wallet);
      await transactions.insert(opening);
      await ledger.insert(openingEntry);
      for (const evento of eventos) {
        await outbox.insert(OutboxMessage.enqueue(evento));
      }
    });
    this.metrics.increment('wager_transactions_total', {
      kind: opening.kind,
      status: opening.status,
      source: 'internal',
    });
    return wallet;
  }
}

@Injectable()
export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run(({ wallets }) => wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
