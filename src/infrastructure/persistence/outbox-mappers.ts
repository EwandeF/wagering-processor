import { OutboxMessage } from '../../domain/outbox-message';
import type { OutboxMessageRecord } from './schemas';

export function outboxMessageToRecord(m: OutboxMessage): OutboxMessageRecord {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: m.payload,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt,
    publishedAt: m.publishedAt,
  };
}

export function outboxMessageFromRecord(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: r.publishedAt,
  });
}
