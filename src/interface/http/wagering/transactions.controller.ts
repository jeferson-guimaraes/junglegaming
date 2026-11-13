import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  GetWagerTransaction,
  ProcessWagerTransaction,
} from '@/application/process-wager-transaction';
import type { MoneyProps } from '@/domain/money';
import { type WagerTransaction, WagerTransactionStatus } from '@/domain/wager-transaction';
import { currentCorrelationId, newCorrelationId } from '@/infrastructure/observability/correlation';
import { APP_LOGGER, type AppLogger } from '@/infrastructure/observability/logger';
import { texto, uuid } from '../../validation';
import { parseWagerTransaction } from '../../wager-transaction.input';
import { AuthGuard } from '../auth.guard';

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
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  @Post('wagering/transactions')
  async submeter(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionResponse> {
    const { transaction, idempotentReplay } = await this.processTransaction.execute({
      ...parseWagerTransaction(body, idempotencyKey),
      correlationId: currentCorrelationId() ?? newCorrelationId(),
      causationId: undefined,
    });
    // Só identificadores e estado: valores e payload completo não vão para o log.
    this.logger.info(
      {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        kind: transaction.kind,
        status: transaction.status,
        failureCode: transaction.failureCode,
        idempotentReplay,
      },
      'transação processada',
    );
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
