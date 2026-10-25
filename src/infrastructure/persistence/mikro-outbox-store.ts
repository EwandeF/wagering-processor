import { type EntityData, type FilterQuery, LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxBatchStore } from '../../application/outbox-ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { outboxMessageFromRecord } from './outbox-mappers';
import { type OutboxMessageRecord, OutboxMessageSchema } from './schemas';

export class MikroOutboxStore implements OutboxBatchStore {
  constructor(private readonly orm: MikroORM) {}

  processDue<T>(
    now: Date,
    limit: number,
    work: (messages: OutboxMessage[]) => Promise<T>,
  ): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      // Não publicadas, e sem hora marcada ou com a hora já chegada.
      const due = {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      } as unknown as FilterQuery<OutboxMessageRecord>;

      const records = await em.find(OutboxMessageSchema, due, {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        // SELECT ... FOR UPDATE SKIP LOCKED: outros publishers pulam estas linhas.
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      const messages = records.map(outboxMessageFromRecord);

      const result = await work(messages);

      for (const m of messages) {
        const changes = {
          attempts: m.attempts,
          nextAttemptAt: m.nextAttemptAt ?? null,
          publishedAt: m.publishedAt ?? null,
        } as unknown as EntityData<OutboxMessageRecord>;
        await em.nativeUpdate(OutboxMessageSchema, { id: m.id }, changes);
      }
      return result;
    });
  }
}
