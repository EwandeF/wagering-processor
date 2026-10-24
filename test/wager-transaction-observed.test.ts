import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind, WagerTransactionStatus } from '../src/domain/enums';
import { InvalidTransactionStateError } from '../src/domain/errors';
import { Money } from '../src/domain/money';
import { WagerTransaction } from '../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00Z');

const make = () =>
  WagerTransaction.create({
    id: 't1', providerId: 'p', externalTransactionId: 'e1', idempotencyKey: 'p:e1',
    payloadHash: 'h', walletId: 'w1', playerId: 'pl1', roundId: 'r1', gameId: 'g1',
    kind: WagerTransactionKind.Bet, money: brl('25.00'), createdAt: at,
  });

describe('saldo observado', () => {
  test('nasce sem saldo observado', () => {
    expect(make().observedBalance).toBeUndefined();
  });

  test('registra o saldo e depois processa', () => {
    const t = make();
    t.recordObservedBalance(brl('75.00'));
    t.markProcessed(undefined, at);
    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.observedBalance?.toString()).toBe('75.00');
  });

  test('transação terminal não aceita registrar saldo', () => {
    const t = make();
    t.recordObservedBalance(brl('75.00'));
    t.markProcessed(undefined, at);
    expect(() => t.recordObservedBalance(brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(t.observedBalance?.toString()).toBe('75.00');
  });

  test('rehydrate preserva o saldo observado', () => {
    const t = WagerTransaction.rehydrate({
      id: 't1', providerId: 'p', externalTransactionId: 'e1', idempotencyKey: 'p:e1',
      payloadHash: 'h', walletId: 'w1', playerId: 'pl1', roundId: 'r1', gameId: 'g1',
      kind: WagerTransactionKind.Bet, money: brl('25.00'), createdAt: at,
      status: WagerTransactionStatus.Processed, processedAt: at,
      observedBalance: brl('75.00'),
    });
    expect(t.observedBalance?.toString()).toBe('75.00');
  });
});
