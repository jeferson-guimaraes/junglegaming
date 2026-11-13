import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '@/domain/money';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import { InvalidPayloadError, WalletNotFoundError } from './errors';
import { Metrics, UnitOfWork } from './ports';

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Presente quando pode haver mais lançamentos; ausente na última página. */
  nextCursor: string | undefined;
}

/** O cursor é opaco para o cliente: por dentro, guarda a posição do último lançamento visto. */
function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof s === 'string' && /^[1-9]\d{0,17}$/.test(s)) return s;
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError('cursor inválido');
}

@Injectable()
export class ListWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(input: {
    walletId: string;
    cursor: string | undefined;
    limit: number;
  }): Promise<LedgerPage> {
    const afterSeq = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    return this.uow.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(input.walletId))) throw new WalletNotFoundError(input.walletId);
      // Busca um a mais para saber se existe próxima página, sem uma segunda consulta.
      const linhas = await ledger.listByWallet(input.walletId, afterSeq, input.limit + 1);
      const pagina = linhas.slice(0, input.limit);
      const ultimo = pagina.at(-1);
      return {
        items: pagina.map((linha) => linha.entry),
        nextCursor: linhas.length > input.limit && ultimo ? encodeCursor(ultimo.seq) : undefined,
      };
    });
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo guardado com o saldo reconstruído pelo ledger. A wallet é travada durante a
 * leitura: nenhuma transação entra entre ler o saldo e somar os lançamentos. Uma divergência é
 * relatada, contada em métrica e nunca corrigida aqui.
 */
@Injectable()
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const relatorio = await this.uow.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const totais = await ledger.totalsByWallet(walletId);
      const em = (amount: string) => Money.from({ amount, currency: wallet.currency });
      const calculado = em(totais.credits).subtract(em(totais.debits));
      const diferenca = wallet.balance.subtract(calculado);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculado.toJSON(),
        difference: diferenca.toJSON(),
        consistent: diferenca.isZero(),
        checkedEntries: totais.entries,
      };
    });
    if (!relatorio.consistent) {
      this.metrics.increment('wallet_reconciliation_divergences_total');
    }
    return relatorio;
  }
}
