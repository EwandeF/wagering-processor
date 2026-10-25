import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import { InvalidOutboxStateError } from '../src/domain/errors';
import { Money } from '../src/domain/money';
import { OutboxMessage, backoffDelayMs } from '../src/domain/outbox-message';
import { WagerTransaction } from '../src/domain/wager-transaction';
import { WagerTransactionProcessed } from '../src/domain/wager-events';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00.000Z');

const event = () => {
  const t = WagerTransaction.create({
    id: 't1', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'prov:ext1',
    payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind: Kind.Bet, money: brl('25.00'), createdAt: at,
  });
  t.recordObservedBalance(brl('75.00'));
  t.markProcessed(undefined, at);
  return WagerTransactionProcessed.from(t, { eventId: 'ev1', correlationId: 'c1', occurredAt: at });
};

const plus = (ms: number) => new Date(at.getTime() + ms);

describe('OutboxMessage.enqueue', () => {
  test('nasce pendente, sem tentativas e já devida', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe('ev1');
    expect(m.aggregateId).toBe('w1');
    expect(m.eventType).toBe('WagerTransactionProcessed');
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(at)).toBe(true);
    expect(m.publishedAt).toBeUndefined();
  });

  test('o payload é o envelope serializado, em JSON puro', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.payload).toMatchObject({
      eventId: 'ev1', eventType: 'WagerTransactionProcessed', version: 1,
      occurredAt: '2026-10-24T12:00:00.000Z',
    });
    expect(JSON.parse(JSON.stringify(m.payload))).toEqual(m.payload);
  });
});

describe('OutboxMessage: publicação', () => {
  test('markPublished tira a mensagem da fila de pendentes', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(plus(5));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(plus(10_000))).toBe(false);
    expect(m.publishedAt).toEqual(plus(5));
  });

  test('publicar duas vezes e reagendar depois de publicada são erros', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(at);
    expect(() => m.markPublished(at)).toThrow(InvalidOutboxStateError);
    expect(() => m.scheduleRetry(at)).toThrow(InvalidOutboxStateError);
  });
});

describe('OutboxMessage: retry com backoff', () => {
  test('cada falha dobra o atraso: 1s, 2s, 4s', () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(at);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).toEqual(plus(1_000));
    m.scheduleRetry(at);
    expect(m.attempts).toBe(2);
    expect(m.nextAttemptAt).toEqual(plus(2_000));
    m.scheduleRetry(at);
    expect(m.nextAttemptAt).toEqual(plus(4_000));
  });

  test('isDue respeita a hora da próxima tentativa', () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(at);
    expect(m.isDue(plus(999))).toBe(false);
    expect(m.isDue(plus(1_000))).toBe(true);
    expect(m.isDue(plus(60_000))).toBe(true);
  });

  test('o atraso tem teto de 5 minutos', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(9)).toBe(256_000);
    expect(backoffDelayMs(10)).toBe(300_000);
    expect(backoffDelayMs(50)).toBe(300_000);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('reconstrói o estado persistido', () => {
    const m = OutboxMessage.rehydrate({
      id: 'x', aggregateId: 'w1', eventType: 'T', payload: { a: 1 }, occurredAt: at,
      attempts: 3, nextAttemptAt: plus(8_000),
    });
    expect(m.attempts).toBe(3);
    expect(m.isDue(plus(7_999))).toBe(false);
    expect(m.isDue(plus(8_000))).toBe(true);
  });
});
