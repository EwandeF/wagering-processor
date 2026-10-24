import DecimalJs from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Precisão alta para a soma de valores grandes nunca arredondar sem avisar.
const Decimal = DecimalJs.clone({ precision: 40 });
type Dec = InstanceType<typeof Decimal>;

// Exatamente 2 casas, sem sinal, sem zeros à esquerda, até 17 dígitos inteiros
// (cabe em NUMERIC(19,2)). Isso barra NaN, Infinity, "1e3", "", "-5.00", "25.001".
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {}

  /** Porta de entrada: só aceita valores não negativos, no formato do contrato. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount deve ser uma string decimal com exatamente 2 casas, ex.: "25.00"',
      );
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency deve ter 3 letras maiúsculas (ISO-4217)');
    }
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  // Uso interno: resultados de contas podem ser negativos (ex.: negate).
  private static of(value: Dec, currency: string): Money {
    // Evita o "-0.00" que o decimal.js produz ao negar zero.
    return new Money(value.isZero() ? new Decimal(0) : value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com 2 casas, nunca em notação científica. */
  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
