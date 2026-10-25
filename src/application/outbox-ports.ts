import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxBatchStore {
  /**
   * Reserva até `limit` mensagens devidas (FOR UPDATE SKIP LOCKED) e executa `work`.
   * O que `work` alterar nas mensagens (markPublished, scheduleRetry) é gravado no
   * mesmo commit. Se `work` lançar, nada é gravado e a reserva é liberada.
   */
  processDue<T>(
    now: Date,
    limit: number,
    work: (messages: OutboxMessage[]) => Promise<T>,
  ): Promise<T>;
}

export interface EventPublisher {
  /** Lança se a publicação falhar. */
  publish(message: OutboxMessage): Promise<void>;
}
