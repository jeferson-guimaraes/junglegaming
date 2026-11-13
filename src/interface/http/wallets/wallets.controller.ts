import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { GetWallet, OpenWallet } from '@/application/wallets.use-cases';
import type { MoneyProps } from '@/domain/money';
import type { Wallet } from '@/domain/wallet';
import { currentCorrelationId, newCorrelationId } from '@/infrastructure/observability/correlation';
import { AuthGuard } from '../auth.guard';
import { money, objeto, uuid } from '../validation';

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
}
