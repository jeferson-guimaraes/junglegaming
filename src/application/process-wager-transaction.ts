import { Injectable } from '@nestjs/common';
import { InvalidMoneyError, InvalidTransactionError } from '@/domain/errors';
import type { EventContext } from '@/domain/events';
import type { Money } from '@/domain/money';
import { OutboxMessage } from '@/domain/outbox-message';
import { computePayloadHash } from '@/domain/payload-hash';
import { WagerTransaction, type WagerTransactionKind } from '@/domain/wager-transaction';
import { applyWagerTransaction, eventsFor } from '@/domain/wagering-rules';
import {
  DuplicateTransactionError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from './errors';
import { ClockPort, IdGenerator, type Repositories, UnitOfWork } from './ports';

export interface WagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  /** Identificador do que causou a operação (ex.: messageId da fila). */
  causationId?: string | undefined;
}

export interface WagerTransactionResult {
  transaction: WagerTransaction;
  /** A transação já existia com o mesmo payload: nada foi aplicado de novo. */
  idempotentReplay: boolean;
}

/**
 * Caso de uso único de transação, usado pela API HTTP e pelo consumer da fila.
 * Tudo acontece em uma transação SQL, sob lock da wallet: idempotência, regras de negócio,
 * saldo, lançamento e eventos. Ordem de lock: wallet primeiro, transação depois.
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: WagerTransactionCommand): Promise<WagerTransactionResult> {
    const payloadHash = hashDo(command);
    const id = this.ids.next();
    // Validação de contrato antes de abrir a transação SQL: payload inválido não toca o banco.
    criar(command, payloadHash, id, this.clock.now());

    try {
      return await this.uow.run((repositories) =>
        this.aplicar(repositories, command, id, payloadHash),
      );
    } catch (erro) {
      if (!(erro instanceof DuplicateTransactionError)) throw erro;
      // Corrida da mesma key (ou do mesmo par provider/external) em wallets diferentes: o lock
      // da wallet não as serializa e quem perdeu bateu na chave única. A transação SQL já foi
      // desfeita; uma nova, só de leitura, decide entre replay e conflito.
      return this.uow.run(async ({ transactions }) => {
        const existente = await localizar(transactions, command, payloadHash);
        if (existente) return existente;
        throw new TransientInfrastructureError('transação duplicada não encontrada na releitura');
      });
    }
  }

  private async aplicar(
    { wallets, transactions, ledger, outbox }: Repositories,
    command: WagerTransactionCommand,
    id: string,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const wallet = await wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);
    // O relógio é lido depois do lock: as datas seguem a ordem real de aplicação na wallet.
    const now = this.clock.now();
    const nova = criar(command, payloadHash, id, now);

    const existente = await localizar(transactions, command, payloadHash);
    if (existente) return existente;

    const reference = nova.referenceExternalTransactionId
      ? await transactions.findByExternalId(nova.providerId, nova.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined &&
      nova.requiresReference() &&
      (await transactions.hasProcessedReversal(reference.id));

    const versaoAntes = wallet.version;
    const outcome = applyWagerTransaction({
      wallet,
      transaction: nova,
      reference,
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      now,
    });
    const nextContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    });
    const eventos = eventsFor({ wallet, transaction: nova, outcome, nextContext });

    await transactions.insert(nova);
    if (outcome.ledgerEntry) {
      await wallets.update(wallet, versaoAntes);
      await ledger.insert(outcome.ledgerEntry);
    }
    for (const evento of eventos) {
      await outbox.insert(OutboxMessage.enqueue(evento));
    }
    return { transaction: nova, idempotentReplay: false };
  }
}

@Injectable()
export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.run(({ transactions }) =>
      transactions.findById(transactionId),
    );
    if (!transaction) throw new TransactionNotFoundError();
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.run(({ transactions }) =>
      transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) throw new TransactionNotFoundError();
    return transaction;
  }
}

function hashDo(command: WagerTransactionCommand): string {
  return computePayloadHash({ ...command, money: command.money.toJSON() });
}

function criar(
  command: WagerTransactionCommand,
  payloadHash: string,
  id: string,
  createdAt: Date,
): WagerTransaction {
  try {
    return WagerTransaction.create({ ...command, id, payloadHash, createdAt });
  } catch (erro) {
    if (erro instanceof InvalidTransactionError || erro instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(erro.message);
    }
    throw erro;
  }
}

/**
 * Procura uma transação já gravada para o mesmo pedido.
 * - mesma key e mesmo payload → replay;
 * - mesma key com outro payload, ou mesmo par provider/external sob outra key → conflito.
 */
async function localizar(
  transactions: Repositories['transactions'],
  command: WagerTransactionCommand,
  payloadHash: string,
): Promise<WagerTransactionResult | undefined> {
  const porChave = await transactions.findByIdempotencyKey(command.idempotencyKey);
  if (porChave) {
    if (porChave.matchesPayload(payloadHash)) {
      return { transaction: porChave, idempotentReplay: true };
    }
    throw new IdempotencyConflictError('A Idempotency-Key já foi usada com outro payload');
  }
  const porIdExterno = await transactions.findByExternalId(
    command.providerId,
    command.externalTransactionId,
  );
  if (porIdExterno) {
    throw new IdempotencyConflictError(
      'providerId e externalTransactionId já foram usados com outra Idempotency-Key',
    );
  }
  return undefined;
}
