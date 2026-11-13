import { Injectable } from '@nestjs/common';
import { InvalidMoneyError, InvalidTransactionError } from '@/domain/errors';
import { InboxMessage } from '@/domain/inbox-message';
import type { Money } from '@/domain/money';
import { computePayloadHash } from '@/domain/payload-hash';
import { WagerTransaction, type WagerTransactionKind } from '@/domain/wager-transaction';
import { applyAndPersist } from './apply-and-persist';
import {
  DuplicateInboxMessageError,
  DuplicateTransactionError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from './errors';
import { ClockPort, IdGenerator, Metrics, type Repositories, UnitOfWork } from './ports';

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

/** Identificação da mensagem de fila que originou o pedido, para a deduplicação por inbox. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface WagerTransactionResult {
  transaction: WagerTransaction;
  /** A transação já existia com o mesmo payload: nada foi aplicado de novo. */
  idempotentReplay: boolean;
  /** A mensagem de fila já tinha sido processada (inbox): nada foi feito desta vez. */
  duplicateMessage?: boolean;
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
    private readonly metrics: Metrics,
  ) {}

  /**
   * `inbox` vem preenchido quando a entrada é uma mensagem de fila: o registro de inbox entra
   * na mesma transação SQL do efeito financeiro, então a reentrega da mensagem não o repete.
   */
  async execute(
    command: WagerTransactionCommand,
    inbox?: InboxContext,
  ): Promise<WagerTransactionResult> {
    const source = inbox ? 'sqs' : 'http';
    const inicio = performance.now();
    try {
      const resultado = await this.executar(command, inbox);
      const { kind, status } = resultado.transaction;
      if (resultado.duplicateMessage) {
        this.metrics.increment('wager_duplicates_total', { type: 'inbox_duplicate' });
      } else if (resultado.idempotentReplay) {
        this.metrics.increment('wager_duplicates_total', { type: 'idempotent_replay' });
      } else {
        this.metrics.increment('wager_transactions_total', { kind, status, source });
      }
      return resultado;
    } catch (erro) {
      if (erro instanceof IdempotencyConflictError) {
        this.metrics.increment('wager_duplicates_total', { type: 'idempotency_conflict' });
      } else if (erro instanceof TransientInfrastructureError) {
        this.metrics.increment('wager_lock_conflicts_total', { reason: erro.reason });
      }
      throw erro;
    } finally {
      this.metrics.observe(
        'wager_processing_duration_seconds',
        (performance.now() - inicio) / 1000,
        { source },
      );
    }
  }

  private async executar(
    command: WagerTransactionCommand,
    inbox?: InboxContext,
  ): Promise<WagerTransactionResult> {
    const payloadHash = hashDo(command);
    const id = this.ids.next();
    // Validação de contrato antes de abrir a transação SQL: payload inválido não toca o banco.
    criar(command, payloadHash, id, this.clock.now());

    try {
      return await this.uow.run((repositories) =>
        this.aplicar(repositories, command, id, payloadHash, inbox),
      );
    } catch (erro) {
      if (erro instanceof DuplicateInboxMessageError && inbox) {
        // Duas entregas da mesma mensagem ao mesmo tempo: a outra registrou o inbox primeiro.
        return this.uow.run((repositories) =>
          this.mensagemRepetida(repositories, command, payloadHash, inbox),
        );
      }
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
    repositories: Repositories,
    command: WagerTransactionCommand,
    id: string,
    payloadHash: string,
    inbox: InboxContext | undefined,
  ): Promise<WagerTransactionResult> {
    const { wallets, transactions } = repositories;
    if (inbox) {
      const registrada = await repositories.inbox.find(inbox.consumerName, inbox.messageId);
      if (registrada) {
        return this.mensagemRepetida(repositories, command, payloadHash, inbox, registrada);
      }
      const now = this.clock.now();
      const mensagem = InboxMessage.receive({ ...inbox, payloadHash, receivedAt: now });
      mensagem.markProcessed(now); // vale junto com o commit desta transação
      await repositories.inbox.insert(mensagem);
    }

    const wallet = await wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);
    // O relógio é lido depois do lock: as datas seguem a ordem real de aplicação na wallet.
    const now = this.clock.now();
    const nova = criar(command, payloadHash, id, now);

    const existente = await localizar(transactions, command, payloadHash);
    if (existente) return existente;

    await applyAndPersist(repositories, {
      wallet,
      transaction: nova,
      novo: true,
      correlationId: command.correlationId,
      causationId: command.causationId,
      now,
      ids: this.ids,
    });
    return { transaction: nova, idempotentReplay: false };
  }

  /** A mensagem já foi processada: devolve o resultado gravado, sem aplicar nada. */
  private async mensagemRepetida(
    { inbox: inboxRepository, transactions }: Repositories,
    command: WagerTransactionCommand,
    payloadHash: string,
    inbox: InboxContext,
    registrada?: InboxMessage,
  ): Promise<WagerTransactionResult> {
    const mensagem =
      registrada ?? (await inboxRepository.find(inbox.consumerName, inbox.messageId));
    if (!mensagem) {
      throw new TransientInfrastructureError('inbox duplicado não encontrado na releitura');
    }
    if (mensagem.payloadHash !== payloadHash) throw new InboxPayloadMismatchError(inbox.messageId);
    const transaction = await transactions.findByIdempotencyKey(command.idempotencyKey);
    // Mesmo messageId e mesmo conteúdo de negócio, mas com outra idempotency key: a key não
    // entra no hash. É a mesma mensagem adulterada, e repetir não muda o resultado.
    if (!transaction) throw new InboxPayloadMismatchError(inbox.messageId);
    return { transaction, idempotentReplay: true, duplicateMessage: true };
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
