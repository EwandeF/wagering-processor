import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutbox } from '../application/publish-outbox';
import { ReprocessPendingReferences } from '../application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import {
  consumerMaxReceiveCount,
  outboxPollMs,
  referencePollMs,
  workersEnabled,
} from '../config';
import { Metrics } from '../infrastructure/observability/metrics';
import { MikroOutboxStore } from '../infrastructure/persistence/mikro-outbox-store';
import { MikroPendingReferenceFinder } from '../infrastructure/persistence/mikro-pending-reference-finder';
import { eventsQueueUrl, wagerDlqUrl, wagerQueueUrl } from '../infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '../infrastructure/sqs/sqs-event-publisher';
import { type ConsumerEvent, WagerQueueConsumer } from '../infrastructure/sqs/wager-queue-consumer';
import { BACKGROUND_WORKERS, ORM, SQS_CLIENT } from '../infrastructure/tokens';
import { WageringModule } from '../wagering.module';
import { BackgroundWorkers } from './background-workers';
import { recordConsumerEvent } from './consumer-metrics';

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: BACKGROUND_WORKERS,
      useFactory: (orm: MikroORM, submit: SubmitWagerTransaction, sqs: SQSClient, metrics: Metrics) => {
        const logger = new Logger('Workers');
        const now = () => new Date();

        const publisher = new PublishOutbox(
          new MikroOutboxStore(orm),
          new SqsEventPublisher(sqs, eventsQueueUrl()),
          now,
          50,
          (message, error) => {
            metrics.outboxPublishFailures.inc();
            logger.warn(`falha ao publicar ${message.eventType} ${message.id}: ${describeError(error)}`);
          },
        );
        const publishOutbox = {
          runOnce: async () => {
            const result = await publisher.runOnce();
            metrics.outboxPublished.inc(result.published);
            return result;
          },
        };

        const reprocessReferences = new ReprocessPendingReferences(
          new MikroPendingReferenceFinder(orm),
          submit,
          now,
          50,
          5,
          (id, error) => logger.warn(`falha ao reprocessar a transação ${id}: ${describeError(error)}`),
          (outcome) => metrics.pendingReference.inc({ outcome }),
        );

        const consumer = new WagerQueueConsumer({
          client: sqs,
          queueUrl: wagerQueueUrl(),
          deadLetterQueueUrl: wagerDlqUrl(),
          useCase: submit,
          maxReceiveCount: consumerMaxReceiveCount(),
          onEvent: (event) => {
            recordConsumerEvent(metrics, event);
            if (event.type === 'error') {
              logger.error(`erro no consumidor: ${describeError(event.error)}`);
            } else {
              logger.log(event);
            }
          },
        });

        return new BackgroundWorkers({
          publishOutbox,
          reprocessReferences,
          consumer,
          outboxPollMs: outboxPollMs(),
          referencePollMs: referencePollMs(),
          onError: (name, error) => logger.error(`laço ${name}: ${describeError(error)}`),
        });
      },
      inject: [ORM, SubmitWagerTransaction, SQS_CLIENT, Metrics],
    },
  ],
})
export class WorkersModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(BACKGROUND_WORKERS) private readonly workers: BackgroundWorkers) {}

  onApplicationBootstrap(): void {
    if (workersEnabled()) {
      this.workers.start();
    }
  }

  /** Roda antes de fechar o servidor HTTP e o banco: os workers terminam o que começaram. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const logger = new Logger('Workers');
    const t0 = Date.now();
    logger.log(`encerrando workers (sinal: ${signal ?? 'nenhum'})`);
    await this.workers.stop();
    logger.log(`workers encerrados em ${Date.now() - t0} ms`);
  }
}
