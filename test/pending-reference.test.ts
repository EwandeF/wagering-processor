import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/enums';
import { InvalidTransactionStateError } from '../src/domain/errors';
import { FailureCode } from '../src/domain/failure-code';
import { Money } from '../src/domain/money';
import {
  DEFAULT_PENDING_REFERENCE_POLICY as policy,
  isReferenceExhausted,
  referenceDelayMs,
  referenceWindowMs,
} from '../src/domain/pending-reference-policy';
import { WagerTransaction } from '../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00.000Z');
const plus = (ms: number) => new Date(at.getTime() + ms);

const refund = () =>
  WagerTransaction.create({
    id: 't1', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'prov:ext1',
    payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind: Kind.Refund, money: brl('25.00'), referenceExternalTransactionId: 'ext0', createdAt: at,
  });

describe('política de referências pendentes', () => {
  test('o atraso dobra a cada checagem e para no teto de 10 minutos', () => {
    const delays = Array.from({ length: 12 }, (_, n) => referenceDelayMs(policy, n) / 1000);
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600, 600, 600, 600]);
  });

  test('12 checagens cobrem cerca de 1 hora', () => {
    expect(referenceWindowMs(policy)).toBe(3_635_000);
  });

  test('esgota na 12ª checagem', () => {
    expect(isReferenceExhausted(policy, 11)).toBe(false);
    expect(isReferenceExhausted(policy, 12)).toBe(true);
  });
});

describe('agendamento na transação', () => {
  test('markPendingReference guarda a hora da primeira checagem', () => {
    const t = refund();
    t.markPendingReference(plus(5_000));
    expect(t.status).toBe(Status.PendingReference);
    expect(t.referenceAttempts).toBe(0);
    expect(t.nextReferenceAttemptAt).toEqual(plus(5_000));
  });

  test('isReferenceDue respeita a hora marcada', () => {
    const t = refund();
    expect(t.isReferenceDue(plus(60_000))).toBe(false); // ainda PENDING
    t.markPendingReference(plus(5_000));
    expect(t.isReferenceDue(plus(4_999))).toBe(false);
    expect(t.isReferenceDue(plus(5_000))).toBe(true);
  });

  test('retryReference soma a tentativa e reagenda', () => {
    const t = refund();
    t.markPendingReference(plus(5_000));
    t.retryReference(plus(15_000));
    expect(t.referenceAttempts).toBe(1);
    expect(t.nextReferenceAttemptAt).toEqual(plus(15_000));
    expect(t.status).toBe(Status.PendingReference);
  });

  test('retryReference só vale para quem aguarda referência', () => {
    expect(() => refund().retryReference(plus(1))).toThrow(InvalidTransactionStateError);
    const done = refund();
    done.markPendingReference(plus(1));
    done.reject(FailureCode.ReferenceNotFound);
    expect(() => done.retryReference(plus(2))).toThrow(InvalidTransactionStateError);
  });

  test('processar ou rejeitar apaga o agendamento', () => {
    const a = refund();
    a.markPendingReference(plus(5_000));
    a.markProcessed('ref-id', at);
    expect(a.nextReferenceAttemptAt).toBeUndefined();
    expect(a.isReferenceDue(plus(99_000))).toBe(false);

    const b = refund();
    b.markPendingReference(plus(5_000));
    b.reject(FailureCode.ReferenceNotFound);
    expect(b.nextReferenceAttemptAt).toBeUndefined();
  });

  test('rehydrate preserva tentativas e agendamento', () => {
    const t = WagerTransaction.rehydrate({
      id: 't1', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'prov:ext1',
      payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
      kind: Kind.Refund, money: brl('25.00'), referenceExternalTransactionId: 'ext0',
      createdAt: at, status: Status.PendingReference, referenceAttempts: 4,
      nextReferenceAttemptAt: plus(80_000),
    });
    expect(t.referenceAttempts).toBe(4);
    expect(t.nextReferenceAttemptAt).toEqual(plus(80_000));
  });
});
