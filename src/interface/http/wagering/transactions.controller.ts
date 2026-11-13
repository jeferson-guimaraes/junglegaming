import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  GetWagerTransaction,
  ProcessWagerTransaction,
} from '@/application/process-wager-transaction';
import type { MoneyProps } from '@/domain/money';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wager-transaction';
import { currentCorrelationId, newCorrelationId } from '@/infrastructure/observability/correlation';
import { AuthGuard } from '../auth.guard';
import { money, objeto, texto, umDe, uuid } from '../validation';

/** Tipos que um provedor pode submeter. OPENING é interno. */
const KINDS_ACEITOS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/**
 * Um status por situação. O replay devolve o estado atual da transação: uma rejeição continua
 * 422, e uma transação que respondeu 202 passa a responder 201 depois de aplicada.
 * 201 aplicada · 202 aceita, aguardando a referência · 422 rejeitada por regra de negócio ·
 * 500 falha permanente de infraestrutura registrada na transação (exige intervenção).
 */
const STATUS_HTTP: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

interface SubmissionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

function resultado(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
  };
}

function detalhe(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    ...(tx.roundId ? { roundId: tx.roundId } : {}),
    ...(tx.gameId ? { gameId: tx.gameId } : {}),
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

@Controller()
@UseGuards(AuthGuard)
export class TransactionsController {
  constructor(
    private readonly processTransaction: ProcessWagerTransaction,
    private readonly getTransaction: GetWagerTransaction,
  ) {}

  @Post('wagering/transactions')
  async submeter(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionResponse> {
    const payload = objeto(body, 'corpo');
    const referencia = payload.referenceExternalTransactionId;
    const { transaction, idempotentReplay } = await this.processTransaction.execute({
      idempotencyKey: texto(idempotencyKey, 'cabeçalho Idempotency-Key', 300),
      providerId: texto(payload.providerId, 'providerId'),
      externalTransactionId: texto(payload.externalTransactionId, 'externalTransactionId'),
      playerId: uuid(payload.playerId, 'playerId'),
      walletId: uuid(payload.walletId, 'walletId'),
      roundId: texto(payload.roundId, 'roundId'),
      gameId: texto(payload.gameId, 'gameId'),
      kind: umDe(payload.kind, 'kind', KINDS_ACEITOS),
      money: money(payload.money, 'money'),
      referenceExternalTransactionId:
        referencia === undefined || referencia === null
          ? undefined
          : texto(referencia, 'referenceExternalTransactionId'),
      correlationId: currentCorrelationId() ?? newCorrelationId(),
    });
    response.status(STATUS_HTTP[transaction.status]);
    return { ...resultado(transaction), idempotentReplay };
  }

  @Get('wagering/transactions/:transactionId')
  async porId(@Param('transactionId') transactionId: string) {
    return detalhe(await this.getTransaction.byId(uuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async porIdExterno(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return detalhe(
      await this.getTransaction.byExternalId(
        texto(providerId, 'providerId'),
        texto(externalTransactionId, 'externalTransactionId'),
      ),
    );
  }
}
