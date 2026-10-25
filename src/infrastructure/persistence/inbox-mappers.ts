import { InboxMessage } from '../../domain/inbox-message';
import type { InboxMessageRecord } from './schemas';

export function inboxMessageToRecord(m: InboxMessage): InboxMessageRecord {
  return {
    consumerName: m.consumerName,
    messageId: m.messageId,
    payloadHash: m.payloadHash,
    receivedAt: m.receivedAt,
    processedAt: m.processedAt,
  };
}

export function inboxMessageFromRecord(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: r.consumerName,
    messageId: r.messageId,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt,
  });
}
