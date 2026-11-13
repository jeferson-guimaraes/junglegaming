import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/errors';
import { Money } from '@/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('criação a partir de contrato de entrada', () => {
    it('aceita string decimal já com 2 casas', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('0.00').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    });

    it.each([
      ['sem casas decimais', '10', '10.00'],
      ['com 1 casa', '10.5', '10.50'],
      ['zero sem casas', '0', '0.00'],
      ['com 2 casas', '10.50', '10.50'],
    ])('normaliza para 2 casas: %s', (_caso, entrada, esperado) => {
      expect(brl(entrada).toJSON().amount).toBe(esperado);
    });

    it('formas diferentes do mesmo valor são iguais', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.5').equals(brl('25.50'))).toBe(true);
    });

    it('aceita o maior valor que cabe em NUMERIC(19,2)', () => {
      const maximo = '99999999999999999.99';

      expect(brl(maximo).toJSON().amount).toBe(maximo);
    });

    it.each([
      ['string vazia', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      ['notação científica', '1e3'],
      ['notação científica com casas', '1.00e2'],
      ['mais de 2 casas', '10.001'],
      ['ponto sem casas', '10.'],
      ['negativo', '-1.00'],
      ['sinal de mais', '+1.00'],
      ['zero à esquerda', '007.00'],
      ['vírgula decimal', '10,00'],
      ['separador de milhar', '1,000.00'],
      ['espaços', ' 10.00 '],
      ['hexadecimal', '0x10.00'],
      ['sem parte inteira', '.50'],
      ['acima do teto de NUMERIC(19,2)', '100000000000000000.00'],
    ])('rejeita %s', (_caso, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it.each([
      ['number', 25],
      ['null', null],
      ['undefined', undefined],
      ['objeto', {}],
    ])('rejeita amount que não é string: %s', (_caso, amount) => {
      expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string', '25.00'],
    ])('rejeita props que não são objeto: %s', (_caso, props) => {
      expect(() => Money.from(props as unknown as { amount: string; currency: string })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each([
      ['minúscula', 'brl'],
      ['curta', 'BR'],
      ['longa', 'BRLL'],
      ['vazia', ''],
      ['com dígito', 'BR1'],
    ])('rejeita moeda fora do formato ISO-4217: %s', (_caso, currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('zero cria o valor nulo da moeda', () => {
      expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(Money.zero('BRL').isZero()).toBe(true);
    });
  });

  describe('aritmética exata', () => {
    it('soma sem erro de ponto flutuante', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    });

    it('subtrai sem erro de ponto flutuante', () => {
      expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
    });

    it('não perde precisão perto do teto', () => {
      const quaseMaximo = brl('99999999999999999.98');

      expect(quaseMaximo.add(brl('0.01')).toJSON().amount).toBe('99999999999999999.99');
    });

    it('rejeita soma que ultrapassa o teto, em vez de arredondar', () => {
      expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
    });

    it('subtração pode resultar em valor negativo, serializado com sinal', () => {
      const diferenca = brl('10.00').subtract(brl('25.50'));

      expect(diferenca.isNegative()).toBe(true);
      expect(diferenca.toJSON().amount).toBe('-15.50');
    });

    it('negate inverte o sinal e mantém o zero sem sinal', () => {
      expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
      expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    });
  });

  describe('imutabilidade', () => {
    it('operações devolvem nova instância e não alteram os operandos', () => {
      const a = brl('10.00');
      const b = brl('3.00');

      const soma = a.add(b);
      const diferenca = a.subtract(b);
      const negado = a.negate();

      expect(soma).not.toBe(a);
      expect(diferenca).not.toBe(a);
      expect(negado).not.toBe(a);
      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('3.00');
    });

    it('a instância é congelada', () => {
      expect(Object.isFrozen(brl('1.00'))).toBe(true);
    });
  });

  describe('comparações', () => {
    it('isZero, isPositive e isNegative', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('isLessThan compara valores da mesma moeda', () => {
      expect(brl('19.99').isLessThan(brl('20.00'))).toBe(true);
      expect(brl('20.00').isLessThan(brl('20.00'))).toBe(false);
      expect(brl('20.01').isLessThan(brl('20.00'))).toBe(false);
    });

    it('equals exige mesmo valor e mesma moeda', () => {
      expect(brl('10.00').equals(brl('10.00'))).toBe(true);
      expect(brl('10.00').equals(brl('10.01'))).toBe(false);
      expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s entre moedas diferentes lança erro de domínio', (_operacao, operar) => {
      expect(operar).toThrow(CurrencyMismatchError);
    });
  });

  describe('serialização', () => {
    it('toJSON sempre devolve string com 2 casas', () => {
      expect(JSON.stringify({ valor: brl('1000.50') })).toBe(
        '{"valor":{"amount":"1000.50","currency":"BRL"}}',
      );
    });

    it('toString é legível', () => {
      expect(brl('25.00').toString()).toBe('25.00 BRL');
    });

    it('from(toJSON()) reconstrói um valor igual', () => {
      const original = brl('123.45');

      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });
  });
});
