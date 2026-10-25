import { describe, expect, test } from 'bun:test';
import { InvalidInboxStateError } from '../src/domain/errors';
import { InboxMessage } from '../src/domain/inbox-message';

const at = new Date('2026-10-24T12:00:00.000Z');
const base = { messageId: 'msg-1', consumerName: 'wager-transactions', payloadHash: 'h1', receivedAt: at };

describe('InboxMessage', () => {
  test('nasce recebida e ainda não processada', () => {
    const m = InboxMessage.receive(base);
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
    expect(m.matchesPayload('h1')).toBe(true);
    expect(m.matchesPayload('outro')).toBe(false);
  });

  test('markProcessed registra a hora e só pode acontecer uma vez', () => {
    const m = InboxMessage.receive(base);
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(at);
    expect(() => m.markProcessed(at)).toThrow(InvalidInboxStateError);
  });

  test('messageId e consumerName não podem ser vazios', () => {
    expect(() => InboxMessage.receive({ ...base, messageId: ' ' })).toThrow(InvalidInboxStateError);
    expect(() => InboxMessage.receive({ ...base, consumerName: '' })).toThrow(InvalidInboxStateError);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const m = InboxMessage.rehydrate({ ...base, processedAt: at });
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(at)).toThrow(InvalidInboxStateError);
  });
});
