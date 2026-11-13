import DecimalBase from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Formato do valor monetário nos contratos (HTTP, fila, eventos): sempre string decimal. */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

/**
 * Decimal com precisão de sobra para o teto de NUMERIC(19,2). Soma e subtração de valores
 * com 2 casas são exatas; a precisão alta só garante que nada seja arredondado no caminho.
 */
const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

const ESCALA = 2;
/**
 * Escala fixa: até 17 dígitos inteiros, sem zeros à esquerda, e exatamente 2 casas, o que cabe
 * em NUMERIC(19,2). "10" e "10.5" são rejeitados, assim como mais de 2 casas: o valor entra e
 * sai sempre na mesma forma, sem normalização nem arredondamento.
 */
const FORMATO_AMOUNT = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const FORMATO_CURRENCY = /^[A-Z]{3}$/;
const TETO = new Decimal('99999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (value.abs().greaterThan(TETO)) {
      throw new InvalidMoneyError(`Valor fora do limite suportado: ${value.toFixed(ESCALA)}`);
    }
    Object.freeze(this);
  }

  /**
   * Cria a partir de um contrato de entrada ou da persistência.
   * Só aceita string decimal não negativa com exatamente 2 casas.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money deve ser um objeto com amount e currency');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !FORMATO_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        'amount deve ser uma string decimal não negativa com exatamente 2 casas, ex.: "25.00"',
      );
    }
    Money.assertCurrency(currency);
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  /** Maior valor suportado (teto de NUMERIC(19,2)). */
  static max(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(TETO, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.isZero() ? this.value : this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(ESCALA), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(ESCALA)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !FORMATO_CURRENCY.test(currency)) {
      throw new InvalidMoneyError('currency deve ser um código ISO-4217 de 3 letras maiúsculas');
    }
  }
}
