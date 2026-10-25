import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WagerTransactionKind as Kind } from '../src/domain/enums';
import { InvalidWagerTransactionError } from '../src/domain/errors';
import { FailureCode } from '../src/domain/failure-code';
import { Money } from '../src/domain/money';
import { WagerTransaction } from '../src/domain/wager-transaction';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../src/domain/wager-events';
import { Wallet } from '../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00.000Z');
const ctx = { eventId: 'ev1', correlationId: 'corr1', causationId: 'cause1', occurredAt: at };

const make = (kind: Kind, amount: string, ref?: string) =>
  WagerTransaction.create({
    id: 't1', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'prov:ext1',
    payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind, money: brl(amount), referenceExternalTransactionId: ref, createdAt: at,
  });

const processed = () => {
  const t = make(Kind.Bet, '25.00');
  t.recordObservedBalance(brl('75.00'));
  t.markProcessed(undefined, at);
  return t;
};
const rejected = () => {
  const t = make(Kind.Bet, '25.00');
  t.recordObservedBalance(brl('10.00'));
  t.reject(FailureCode.InsufficientFunds);
  return t;
};
const pending = () => {
  const t = make(Kind.Refund, '25.00', 'ext0');
  t.recordObservedBalance(brl('100.00'));
  t.markPendingReference(at);
  return t;
};

describe('WagerTransactionProcessed', () => {
  test('envelope e dados', () => {
    const e = WagerTransactionProcessed.from(processed(), ctx);
    expect(e.eventType).toBe('WagerTransactionProcessed');
    expect(e.version).toBe(1);
    expect(e.aggregateId).toBe('w1'); // o aggregateId é a wallet
    const json = e.toJSON();
    expect(json).toMatchObject({
      eventId: 'ev1', correlationId: 'corr1', causationId: 'cause1',
      occurredAt: '2026-10-24T12:00:00.000Z', version: 1,
    });
    expect(json.data).toMatchObject({
      transactionId: 't1', kind: 'BET', status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('o payload é JSON puro: dinheiro como string, sem instância de Money', () => {
    const e = WagerTransactionProcessed.from(processed(), ctx);
    const roundTrip = JSON.parse(JSON.stringify(e));
    expect(roundTrip).toEqual(JSON.parse(JSON.stringify(e.toJSON())));
    expect(typeof roundTrip.data.money.amount).toBe('string');
    expect(roundTrip.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('recusa transação que não está PROCESSED', () => {
    expect(() => WagerTransactionProcessed.from(rejected(), ctx)).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransactionProcessed.from(pending(), ctx)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransactionRejected', () => {
  test('traz failureCode e providerAction', () => {
    const e = WagerTransactionRejected.from(rejected(), ctx);
    expect(e.eventType).toBe('WagerTransactionRejected');
    expect(e.data).toMatchObject({
      status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', providerAction: 'RETRY_LATER',
      balance: { amount: '10.00', currency: 'BRL' },
    });
  });

  test('recusa transação que não está REJECTED', () => {
    expect(() => WagerTransactionRejected.from(processed(), ctx)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransactionPendingReference', () => {
  test('traz a referência que falta', () => {
    const e = WagerTransactionPendingReference.from(pending(), ctx);
    expect(e.eventType).toBe('WagerTransactionPendingReference');
    expect(e.data).toMatchObject({
      status: 'PENDING_REFERENCE', kind: 'REFUND', referenceExternalTransactionId: 'ext0',
    });
  });

  test('recusa transação que não está PENDING_REFERENCE', () => {
    expect(() => WagerTransactionPendingReference.from(processed(), ctx)).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WalletBalanceChanged', () => {
  test('descreve o movimento de saldo e a version da wallet', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: at });
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 't1', entryId: 'e1', at });
    const e = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(e.eventType).toBe('WalletBalanceChanged');
    expect(e.aggregateId).toBe('w1');
    expect(e.data).toEqual({
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

describe('IntegrationEvent', () => {
  test('causationId é opcional e some do JSON quando ausente', () => {
    const { causationId: _omit, ...withoutCausation } = ctx;
    const e = WagerTransactionProcessed.from(processed(), withoutCausation);
    expect('causationId' in JSON.parse(JSON.stringify(e))).toBe(false);
  });
});
