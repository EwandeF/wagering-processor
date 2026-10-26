import { describe, expect, test } from 'bun:test';
import { Metrics } from '../src/infrastructure/observability/metrics';
import { recordConsumerEvent } from '../src/workers/consumer-metrics';

async function line(metrics: Metrics, name: string, labels = ''): Promise<number> {
  const text = await metrics.registry.metrics();
  const wanted = labels ? `${name}{${labels}} ` : `${name} `;
  const found = text.split('\n').find((l) => l.startsWith(wanted));
  return found ? Number(found.slice(wanted.length)) : 0;
}

describe('recordConsumerEvent', () => {
  test('mensagem processada e mensagem repetida da inbox contam separado', async () => {
    const m = new Metrics();
    recordConsumerEvent(m, { type: 'processed', messageId: 'a', status: 'PROCESSED', duplicateMessage: false, idempotentReplay: false });
    recordConsumerEvent(m, { type: 'processed', messageId: 'b', status: 'PROCESSED', duplicateMessage: true, idempotentReplay: true });
    recordConsumerEvent(m, { type: 'processed', messageId: 'c', status: 'REJECTED', duplicateMessage: false, idempotentReplay: false });
    expect(await line(m, 'wager_consumer_messages_total', 'result="processed"')).toBe(2);
    expect(await line(m, 'wager_consumer_messages_total', 'result="duplicate_message"')).toBe(1);
  });

  test('conflito de negócio, retry e devolução à fila', async () => {
    const m = new Metrics();
    recordConsumerEvent(m, { type: 'business-conflict', messageId: 'a', code: 'IDEMPOTENCY_CONFLICT' });
    recordConsumerEvent(m, { type: 'retry', messageId: 'a', receiveCount: 1, delaySeconds: 1, code: 'X' });
    recordConsumerEvent(m, { type: 'retry', messageId: 'a', receiveCount: 2, delaySeconds: 2, code: 'X' });
    recordConsumerEvent(m, { type: 'released', messageId: 'a' });
    expect(await line(m, 'wager_consumer_messages_total', 'result="business_conflict"')).toBe(1);
    expect(await line(m, 'wager_consumer_messages_total', 'result="released"')).toBe(1);
    expect(await line(m, 'wager_consumer_retries_total')).toBe(2);
  });

  test('DLQ por motivo; erro do laço não conta como mensagem', async () => {
    const m = new Metrics();
    recordConsumerEvent(m, { type: 'dead-letter', messageId: 'a', reason: 'permanent', code: 'MALFORMED_MESSAGE', receiveCount: 1 });
    recordConsumerEvent(m, { type: 'dead-letter', messageId: 'b', reason: 'max-attempts', code: 'X', receiveCount: 5 });
    recordConsumerEvent(m, { type: 'dead-letter', messageId: 'c', reason: 'permanent', code: 'INVALID_MONEY', receiveCount: 1 });
    recordConsumerEvent(m, { type: 'error', error: new Error('rede') });
    expect(await line(m, 'wager_dlq_messages_total', 'reason="permanent"')).toBe(2);
    expect(await line(m, 'wager_dlq_messages_total', 'reason="max-attempts"')).toBe(1);
    expect(await line(m, 'wager_consumer_messages_total', 'result="processed"')).toBe(0);
  });
});
