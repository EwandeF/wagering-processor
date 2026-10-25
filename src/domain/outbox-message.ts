import { InvalidOutboxStateError } from './errors';
import type { IntegrationEvent } from './integration-event';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

/** Atraso antes da tentativa seguinte: 1s, 2s, 4s... com teto de 5 minutos. */
export function backoffDelayMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O eventId vira o id da linha: um evento existe uma única vez na outbox. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // Ida e volta por JSON: garante payload puro (datas em ISO, sem undefined).
    const payload = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com a hora da próxima tentativa já chegada (ou sem hora marcada). */
  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(`mensagem ${this.id} já foi publicada`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(`mensagem ${this.id} já foi publicada`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts));
  }
}
