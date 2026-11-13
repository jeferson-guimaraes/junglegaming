import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidLedgerEntryError } from '@/domain/errors';
import { Money } from '@/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AGORA = new Date('2026-11-12T12:00:00.000Z');

function props(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    createdAt: AGORA,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  it('cria um débito cuja aritmética fecha', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  it('cria um crédito cuja aritmética fecha', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: brl('30.00'),
        balanceBefore: brl('20.00'),
        balanceAfter: brl('50.00'),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  it.each([
    ['débito que não fecha', props({ balanceAfter: brl('30.00') })],
    [
      'crédito que não fecha',
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('20.00') }),
    ],
    ['valor zero', props({ money: brl('0.00'), balanceAfter: brl('100.00') })],
    ['valor negativo', props({ money: brl('80.00').negate(), balanceAfter: brl('180.00') })],
    [
      'saldo posterior negativo',
      props({ money: brl('120.00'), balanceAfter: brl('100.00').subtract(brl('120.00')) }),
    ],
  ])('rejeita lançamento inválido: %s', (_caso, invalido) => {
    expect(() => WalletLedgerEntry.create(invalido)).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita moedas diferentes entre valor e saldos', () => {
    const usd = Money.from({ amount: '80.00', currency: 'USD' });

    expect(() => WalletLedgerEntry.create(props({ money: usd }))).toThrow(CurrencyMismatchError);
  });

  it('é imutável: congelado e sem métodos de transição', () => {
    const entry = WalletLedgerEntry.create(props());
    const metodos = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(metodos.toSorted()).toEqual(['constructor', 'isBalanced']);
  });

  it('rehydrate reconstrói o estado persistido sem revalidar', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-9',
      walletId: 'wallet-1',
      transactionId: 'tx-9',
      direction: LedgerDirection.Credit,
      amount: '10.00',
      currency: 'BRL',
      balanceBefore: '5.00',
      balanceAfter: '999.00', // inconsistente de propósito: rehydrate não valida
      createdAt: AGORA,
    });

    expect(entry.id).toBe('entry-9');
    expect(entry.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(false);
  });
});
