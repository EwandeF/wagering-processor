import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../src/domain/enums';
import { InvalidLedgerEntryError } from '../src/domain/errors';
import { Money } from '../src/domain/money';
import { WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  createdAt: new Date('2026-10-24T12:00:00Z'),
};

describe('WalletLedgerEntry.create', () => {
  test('crédito válido fecha a conta', () => {
    const e = WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit,
      money: brl('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('125.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test('débito válido fecha a conta', () => {
    const e = WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Debit,
      money: brl('80.00'), balanceBefore: brl('100.00'), balanceAfter: brl('20.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test('rejeita conta que não fecha', () => {
    expect(() => WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit,
      money: brl('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('999.00'),
    })).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita direção trocada', () => {
    expect(() => WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Debit,
      money: brl('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('125.00'),
    })).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero', () => {
    expect(() => WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit,
      money: brl('0.00'), balanceBefore: brl('100.00'), balanceAfter: brl('100.00'),
    })).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita moedas misturadas', () => {
    expect(() => WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit,
      money: usd('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('125.00'),
    })).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita saldo resultante negativo', () => {
    expect(() => WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Debit,
      money: brl('150.00'), balanceBefore: brl('100.00'),
      balanceAfter: brl('100.00').subtract(brl('150.00')),
    })).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida: reconstrói o estado mesmo inconsistente', () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base, direction: LedgerDirection.Credit,
      money: brl('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('999.00'),
    });
    expect(e.isBalanced()).toBe(false);
  });
});
