import type { Metrics } from '../infrastructure/observability/metrics';
import type { ConsumerEvent } from '../infrastructure/sqs/wager-queue-consumer';

/** Traduz o que o consumidor da fila reporta nos contadores. */
export function recordConsumerEvent(metrics: Metrics, event: ConsumerEvent): void {
  switch (event.type) {
    case 'processed':
      metrics.consumerMessages.inc({ result: event.duplicateMessage ? 'duplicate_message' : 'processed' });
      break;
    case 'business-conflict':
      metrics.consumerMessages.inc({ result: 'business_conflict' });
      break;
    case 'retry':
      metrics.consumerRetries.inc();
      break;
    case 'dead-letter':
      metrics.dlqMessages.inc({ reason: event.reason });
      break;
    case 'released':
      metrics.consumerMessages.inc({ result: 'released' });
      break;
    default:
      break;
  }
}
