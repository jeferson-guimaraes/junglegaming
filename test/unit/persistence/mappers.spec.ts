import { describe, expect, it } from 'bun:test';
import { Money } from '@/domain/money';
import { Wallet } from '@/domain/wallet';
import { walletFromRecord, walletToRecord } from '@/infrastructure/persistence/mappers';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-12T12:00:00.000Z');

describe('Mapeadores de persistência', () => {
  it('wallet vai e volta sem perder precisão: 0.10 + 0.20 continua 0.30', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.10'),
      now: T0,
      opening: { entryId: 'entry-0', transactionId: 'tx-0' },
    });
    wallet.credit({ money: brl('0.20'), transactionId: 'tx-1', entryId: 'entry-1', now: T0 });

    const record = walletToRecord(wallet);
    const devolta = walletFromRecord(record);

    expect(record.balance).toBe('0.30');
    expect(typeof record.balance).toBe('string');
    expect(devolta.balance.equals(brl('0.30'))).toBe(true);
    expect(devolta.version).toBe(2);
    expect(walletToRecord(devolta)).toEqual(record);
  });

  it('o maior valor suportado vai e volta exato', () => {
    const maximo = '99999999999999999.99';
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: maximo,
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });

    expect(walletFromRecord(walletToRecord(wallet)).balance.toJSON().amount).toBe(maximo);
  });
});
