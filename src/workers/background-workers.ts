import type { PublishOutbox } from '../application/publish-outbox';
import type { ReprocessPendingReferences } from '../application/reprocess-pending-references';
import type { WagerQueueConsumer } from '../infrastructure/sqs/wager-queue-consumer';
import { PollingLoop } from './polling-loop';

export interface BackgroundWorkersDeps {
  publishOutbox: PublishOutbox;
  reprocessReferences: ReprocessPendingReferences;
  consumer: WagerQueueConsumer;
  outboxPollMs: number;
  referencePollMs: number;
  onError: (name: string, error: unknown) => void;
}

/** Os três processos de fundo de uma instância: outbox, referências pendentes e fila. */
export class BackgroundWorkers {
  private readonly outboxLoop: PollingLoop;
  private readonly referenceLoop: PollingLoop;
  private readonly consumer: WagerQueueConsumer;

  constructor(deps: BackgroundWorkersDeps) {
    this.consumer = deps.consumer;
    this.outboxLoop = new PollingLoop({
      name: 'outbox-publisher',
      intervalMs: deps.outboxPollMs,
      tick: async () => (await deps.publishOutbox.runOnce()).claimed,
      onError: deps.onError,
    });
    this.referenceLoop = new PollingLoop({
      name: 'pending-references',
      intervalMs: deps.referencePollMs,
      // As que falharam continuam devidas: não contam, senão o laço giraria sem descanso.
      tick: async () => {
        const summary = await deps.reprocessReferences.runOnce();
        return summary.found - summary.failed;
      },
      onError: deps.onError,
    });
  }

  start(): void {
    this.outboxLoop.start();
    this.referenceLoop.start();
    this.consumer.start();
  }

  /** Cada laço termina a rodada em andamento; o consumidor devolve o que não começou. */
  async stop(): Promise<void> {
    await Promise.all([this.outboxLoop.stop(), this.referenceLoop.stop(), this.consumer.stop()]);
  }
}
