import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../src/domain/errors';
import { Money } from '../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test('aceita valor válido e mantém 2 casas', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('0.00').isZero()).toBe(true);
  });

  test.each([
    '', '25', '25.5', '25.001', '-5.00', 'NaN', 'Infinity',
    '1e3', '1e3.00', '025.00', ' 25.00', '25.00 ', '.50', '1,00',
  ])('rejeita amount inválido: "%s"', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string', () => {
    const props = { amount: 25 as unknown as string, currency: 'BRL' };
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', ''])('rejeita currency inválida: "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('aceita 17 dígitos inteiros e rejeita 18', () => {
    expect(brl('99999999999999999.99').toString()).toBe('99999999999999999.99');
    expect(() => brl('999999999999999999.99')).toThrow(InvalidMoneyError);
  });
});

describe('Money aritmética', () => {
  test('0.10 + 0.20 é exatamente 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('subtract pode dar negativo internamente', () => {
    const r = brl('10.00').subtract(brl('25.00'));
    expect(r.toString()).toBe('-15.00');
    expect(r.isNegative()).toBe(true);
  });

  test('negate de zero não vira -0.00', () => {
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });

  test('é imutável: operar não altera o original', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    a.negate();
    expect(a.toString()).toBe('10.00');
  });
});

describe('Money comparações e moeda', () => {
  test('isLessThan, isPositive e equals', () => {
    expect(brl('10.00').isLessThan(brl('25.00'))).toBe(true);
    expect(brl('25.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
  });

  test('moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('toJSON serializa como string decimal', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });
});
