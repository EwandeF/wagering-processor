import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../src/domain/enums';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidWalletOperationError,
} from '../src/domain/errors';
import { Money } from '../src/domain/money';
import { Wallet } from '../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00Z');

const openWallet = (balance = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), now: at });

const move = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `t${n}`,
  entryId: `e${n}`,
  at,
});

describe('Wallet.open', () => {
  test('nasce com version 1 e o saldo inicial', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  test('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate() }),
    ).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit', () => {
  test('debita, gera lançamento DEBIT e incrementa a version', () => {
    const w = openWallet();
    const entry = w.debit(move('80.00'));
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('saldo insuficiente falha e não altera nada', () => {
    const w = openWallet();
    expect(() => w.debit(move('100.01'))).toThrow(InsufficientBalanceError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('pode zerar o saldo exatamente', () => {
    const w = openWallet();
    w.debit(move('100.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('cenário: duas apostas de 80 com saldo 100, a segunda falha', () => {
    const w = openWallet();
    w.debit(move('80.00', 1));
    expect(() => w.debit(move('80.00', 2))).toThrow(InsufficientBalanceError);
    expect(w.balance.toString()).toBe('20.00');
  });

  test('rejeita valor zero', () => {
    expect(() => openWallet().debit(move('0.00'))).toThrow(InvalidWalletOperationError);
  });

  test('rejeita moeda diferente', () => {
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => openWallet().debit(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.credit', () => {
  test('credita, gera lançamento CREDIT e incrementa a version', () => {
    const w = openWallet();
    const entry = w.credit(move('25.00'));
    expect(w.balance.toString()).toBe('125.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita moeda diferente sem alterar nada', () => {
    const w = openWallet();
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido', () => {
    const w = Wallet.rehydrate({
      id: 'w1', playerId: 'p1', currency: 'BRL', balance: brl('50.00'),
      version: 7, createdAt: at, updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe('50.00');
  });
});
