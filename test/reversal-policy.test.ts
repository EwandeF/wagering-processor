import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/enums';
import { InvalidWagerTransactionError } from '../src/domain/errors';
import { FailureCode } from '../src/domain/failure-code';
import { Money } from '../src/domain/money';
import { checkReversal } from '../src/domain/reversal-policy';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  type WagerTransactionState,
} from '../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00Z');

const ref = (kind: Kind, o: Partial<WagerTransactionState> = {}) =>
  WagerTransaction.rehydrate({
    id: 'ref', providerId: 'prov', externalTransactionId: 'ext0', idempotencyKey: 'prov:ext0',
    payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind, money: brl('25.00'), createdAt: at, status: Status.Processed,
    processedAt: at, observedBalance: brl('75.00'), ...o,
  });

const reversal = (kind: Kind.Refund | Kind.Rollback, o: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: 'rev', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'prov:ext1',
    payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind, money: brl('25.00'), referenceExternalTransactionId: 'ext0', createdAt: at, ...o,
  });

describe('checkReversal: casos válidos', () => {
  test('REFUND de BET', () => {
    expect(checkReversal(reversal(Kind.Refund), ref(Kind.Bet), false)).toBeUndefined();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK de %s', (kind) => {
    expect(checkReversal(reversal(Kind.Rollback), ref(kind), false)).toBeUndefined();
  });
});

describe('checkReversal: tipo da referência', () => {
  test.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening])(
    'REFUND de %s é inválido', (kind) => {
      expect(checkReversal(reversal(Kind.Refund), ref(kind), false)).toBe(
        FailureCode.InvalidReferenceKind,
      );
    },
  );

  test.each([Kind.Loss, Kind.Rollback, Kind.Opening])('ROLLBACK de %s é inválido', (kind) => {
    expect(checkReversal(reversal(Kind.Rollback), ref(kind), false)).toBe(
      FailureCode.InvalidReferenceKind,
    );
  });
});

describe('checkReversal: pertencimento', () => {
  test.each([
    ['wallet', { walletId: 'outra' }],
    ['jogador', { playerId: 'outro' }],
    ['rodada', { roundId: 'outra' }],
    ['provedor', { providerId: 'outro' }],
    ['moeda', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
  ] as const)('%s diferente é REFERENCE_MISMATCH', (_, override) => {
    expect(checkReversal(reversal(Kind.Refund), ref(Kind.Bet, override), false)).toBe(
      FailureCode.ReferenceMismatch,
    );
  });
});

describe('checkReversal: estado, valor e reversão anterior', () => {
  test.each([Status.Rejected, Status.Failed])('referência %s não pode ser revertida', (status) => {
    const r = ref(Kind.Bet, { status, failureCode: FailureCode.InsufficientFunds });
    expect(checkReversal(reversal(Kind.Refund), r, false)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('valor diferente da referência', () => {
    expect(checkReversal(reversal(Kind.Refund, { money: brl('24.99') }), ref(Kind.Bet), false)).toBe(
      FailureCode.ReversalAmountMismatch,
    );
  });

  test('referência já revertida', () => {
    expect(checkReversal(reversal(Kind.Refund), ref(Kind.Bet), true)).toBe(
      FailureCode.AlreadyReversed,
    );
  });

  test('a ordem das checagens é estável: pertencimento vence o resto', () => {
    const r = ref(Kind.Win, { walletId: 'outra' });
    expect(checkReversal(reversal(Kind.Refund), r, true)).toBe(FailureCode.ReferenceMismatch);
  });

  test('transação que não é reversão é erro de programação', () => {
    const bet = WagerTransaction.create({
      id: 'b', providerId: 'prov', externalTransactionId: 'e', idempotencyKey: 'k',
      payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
      kind: Kind.Bet, money: brl('25.00'), createdAt: at,
    });
    expect(() => checkReversal(bet, ref(Kind.Bet), false)).toThrow(InvalidWagerTransactionError);
  });
});
