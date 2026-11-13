import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InvalidPayloadError } from '@/application/errors';
import {
  LEDGER_PAGE_DEFAULT,
  LEDGER_PAGE_MAX,
  ListWalletLedger,
  ReconcileWallet,
  type ReconciliationReport,
} from '@/application/wallet-queries';
import { GetWallet, OpenWallet } from '@/application/wallets.use-cases';
import type { MoneyProps } from '@/domain/money';
import type { Wallet } from '@/domain/wallet';
import { currentCorrelationId, newCorrelationId } from '@/infrastructure/observability/correlation';
import { APP_LOGGER, type AppLogger } from '@/infrastructure/observability/logger';
import { money, objeto, texto, uuid } from '../../validation';
import { AuthGuard } from '../auth.guard';

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

function resposta(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  @Post()
  async criar(@Body() body: unknown): Promise<WalletResponse> {
    const payload = objeto(body, 'corpo');
    const wallet = await this.openWallet.execute({
      playerId: uuid(payload.playerId, 'playerId'),
      initialBalance: money(payload.initialBalance, 'initialBalance'),
      correlationId: currentCorrelationId() ?? newCorrelationId(),
    });
    return resposta(wallet);
  }

  @Get(':walletId')
  async consultar(@Param('walletId') walletId: string): Promise<WalletResponse> {
    return resposta(await this.getWallet.execute(uuid(walletId, 'walletId')));
  }

  /** Extrato paginado por cursor opaco e estável, na ordem de gravação. */
  @Get(':walletId/ledger')
  async extrato(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const pagina = await this.listLedger.execute({
      walletId: uuid(walletId, 'walletId'),
      cursor: cursor === undefined ? undefined : texto(cursor, 'cursor', 200),
      limit: limite(limit),
    });
    return {
      items: pagina.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: pagina.nextCursor ?? null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliar(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    const relatorio = await this.reconcileWallet.execute(uuid(walletId, 'walletId'));
    if (!relatorio.consistent) {
      // Sem valores no log: quem investiga consulta a wallet e o ledger pelo id.
      this.logger.error(
        { walletId: relatorio.walletId, checkedEntries: relatorio.checkedEntries },
        'reconciliação: saldo da wallet diverge do ledger',
      );
    }
    return relatorio;
  }
}

function limite(valor: unknown): number {
  if (valor === undefined) return LEDGER_PAGE_DEFAULT;
  const numero = typeof valor === 'string' && /^\d{1,4}$/.test(valor) ? Number(valor) : Number.NaN;
  if (!Number.isInteger(numero) || numero < 1 || numero > LEDGER_PAGE_MAX) {
    throw new InvalidPayloadError(`limit deve ser um inteiro entre 1 e ${LEDGER_PAGE_MAX}`);
  }
  return numero;
}
