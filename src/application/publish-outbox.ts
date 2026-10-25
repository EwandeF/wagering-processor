import type { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, OutboxBatchStore } from './outbox-ports';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

export class PublishOutbox {
  constructor(
    private readonly store: OutboxBatchStore,
    private readonly publisher: EventPublisher,
    private readonly clock: () => Date = () => new Date(),
    private readonly batchSize = 50,
    private readonly onFailure: (message: OutboxMessage, error: unknown) => void = () => {},
  ) {}

  /** Um ciclo: reserva um lote, publica e grava o resultado. Seguro com vários em paralelo. */
  runOnce(): Promise<PublishOutboxResult> {
    return this.store.processDue(this.clock(), this.batchSize, async (messages) => {
      let published = 0;
      let failed = 0;
      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock());
          published += 1;
        } catch (error) {
          message.scheduleRetry(this.clock());
          failed += 1;
          this.onFailure(message, error);
        }
      }
      return { claimed: messages.length, published, failed };
    });
  }
}
