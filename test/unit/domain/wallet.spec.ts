import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMovementError,
  InvalidWalletError,
} from '@/domain/errors';
import { Money } from '@/domain/money';
import { Wallet } from '@/domain/wallet';
import { LedgerDirection } from '@/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-12T12:00:00.000Z');
const T1 = new Date('2026-11-12T12:00:05.000Z');

function abrir(saldo: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(saldo),
    now: T0,
    opening: { entryId: 'entry-0', transactionId: 'tx-opening' },
  }).wallet;
}

const movimento = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  entryId: `entry-${n}`,
  now: T1,
});

describe('Wallet', () => {
  describe('abertura', () => {
    it('com saldo inicial nasce na versão 1 e produz o lançamento de crédito da abertura', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('1000.00'),
        now: T0,
        opening: { entryId: 'entry-0', transactionId: 'tx-opening' },
      });

      expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(T0);
      expect(wallet.updatedAt).toEqual(T0);
      expect(openingEntry).toMatchObject({
        id: 'entry-0',
        walletId: 'wallet-1',
        transactionId: 'tx-opening',
        direction: LedgerDirection.Credit,
      });
      expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
      expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
    });

    it('com saldo zero nasce na versão 1 e não produz lançamento', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('0.00'),
        now: T0,
      });

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('saldo inicial positivo sem os dados da transação de abertura é rejeitado', () => {
      expect(() =>
        Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00'), now: T0 }),
      ).toThrow(InvalidWalletError);
    });

    it('saldo inicial negativo é rejeitado', () => {
      expect(() =>
        Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00').negate(), now: T0 }),
      ).toThrow(InvalidWalletError);
    });
  });

  describe('débito', () => {
    it('reduz o saldo, incrementa a versão e devolve o lançamento correspondente', () => {
      const wallet = abrir('100.00');

      const entry = wallet.debit(movimento('80.00'));

      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(T1);
      expect(entry).toMatchObject({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        createdAt: T1,
      });
      expect(entry.money.toJSON().amount).toBe('80.00');
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('permite zerar o saldo', () => {
      const wallet = abrir('100.00');

      wallet.debit(movimento('100.00'));

      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejeita saldo insuficiente sem alterar saldo, versão nem data', () => {
      const wallet = abrir('100.00');

      expect(() => wallet.debit(movimento('100.01'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(T0);
    });

    it('canDebit antecipa a resposta sem alterar nada', () => {
      const wallet = abrir('100.00');

      expect(wallet.canDebit(brl('100.00'))).toBe(true);
      expect(wallet.canDebit(brl('100.01'))).toBe(false);
      expect(wallet.version).toBe(1);
    });

    it('canCredit diz se o crédito cabe no limite suportado, sem alterar nada', () => {
      const wallet = abrir('99999999999999999.98');

      expect(wallet.canCredit(brl('0.01'))).toBe(true);
      expect(wallet.canCredit(brl('0.02'))).toBe(false);
      expect(wallet.version).toBe(1);
    });
  });

  describe('crédito', () => {
    it('aumenta o saldo, incrementa a versão e devolve o lançamento correspondente', () => {
      const wallet = abrir('20.00');

      const entry = wallet.credit(movimento('30.00'));

      expect(wallet.balance.toJSON().amount).toBe('50.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toJSON().amount).toBe('20.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('50.00');
    });
  });

  describe('invariantes comuns a débito e crédito', () => {
    it.each([
      ['debit', (w: Wallet, m: ReturnType<typeof movimento>) => w.debit(m)],
      ['credit', (w: Wallet, m: ReturnType<typeof movimento>) => w.credit(m)],
    ] as const)('%s rejeita moeda diferente da wallet', (_nome, operar) => {
      const wallet = abrir('100.00');
      const usd = { ...movimento('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };

      expect(() => operar(wallet, usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it.each([
      ['debit', (w: Wallet, m: ReturnType<typeof movimento>) => w.debit(m)],
      ['credit', (w: Wallet, m: ReturnType<typeof movimento>) => w.credit(m)],
    ] as const)('%s rejeita valor zero ou negativo', (_nome, operar) => {
      const wallet = abrir('100.00');

      expect(() => operar(wallet, movimento('0.00'))).toThrow(InvalidMovementError);
      expect(() => operar(wallet, { ...movimento('1.00'), money: brl('1.00').negate() })).toThrow(
        InvalidMovementError,
      );
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('a versão sobe 1 a cada mudança de saldo', () => {
      const wallet = abrir('100.00');

      wallet.debit(movimento('10.00', 1));
      wallet.credit(movimento('5.00', 2));
      wallet.debit(movimento('1.00', 3));

      expect(wallet.version).toBe(4);
      expect(wallet.balance.toJSON().amount).toBe('94.00');
    });

    it('o saldo é sempre a soma dos lançamentos devolvidos', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
        now: T0,
        opening: { entryId: 'entry-0', transactionId: 'tx-opening' },
      });
      const lancamentos = [
        openingEntry,
        wallet.debit(movimento('80.00', 1)),
        wallet.credit(movimento('15.50', 2)),
        wallet.debit(movimento('0.01', 3)),
      ];

      const reconstruido = lancamentos.reduce((saldo, entry) => {
        if (!entry) return saldo;
        return entry.direction === LedgerDirection.Credit
          ? saldo.add(entry.money)
          : saldo.subtract(entry.money);
      }, Money.zero('BRL'));

      expect(reconstruido.equals(wallet.balance)).toBe(true);
    });
  });

  describe('reidratação', () => {
    it('reconstrói o estado persistido sem revalidar nem alterar a versão', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-7',
        playerId: 'player-7',
        currency: 'BRL',
        balance: '42.10',
        version: 9,
        createdAt: T0,
        updatedAt: T1,
      });

      expect(wallet.id).toBe('wallet-7');
      expect(wallet.playerId).toBe('player-7');
      expect(wallet.balance.toJSON()).toEqual({ amount: '42.10', currency: 'BRL' });
      expect(wallet.version).toBe(9);
      expect(wallet.updatedAt).toEqual(T1);
    });
  });
});
