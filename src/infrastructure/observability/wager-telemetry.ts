import { Logger } from '@nestjs/common';
import type {
  DuplicateDetected,
  TransactionRecorded,
  WagerObserver,
} from '../../application/observer';
import type { Metrics } from './metrics';

/** Traduz o que o caso de uso reporta em métrica e log estruturado. */
export class WagerTelemetry implements WagerObserver {
  private readonly logger = new Logger('Wager');

  constructor(private readonly metrics: Metrics) {}

  transactionRecorded(event: TransactionRecorded): void {
    this.metrics.transactions.inc({ status: event.status, kind: event.kind });
    this.metrics.processingSeconds.observe({ status: event.status }, event.durationMs / 1000);
    // Só identificadores e resultado: nenhum valor monetário nem payload nos logs.
    this.logger.log({
      event: 'transaction_recorded',
      ...event,
      durationMs: Math.round(event.durationMs),
    });
  }

  duplicateDetected(event: DuplicateDetected): void {
    this.metrics.duplicates.inc({ source: event.source });
    this.logger.log({ event: 'duplicate_detected', ...event });
  }

  walletLockWaited(milliseconds: number): void {
    this.metrics.walletLockWaitSeconds.observe(milliseconds / 1000);
  }

  lockConflict(type: 'duplicate_key_retry' | 'version_conflict'): void {
    this.metrics.lockConflicts.inc({ type });
    this.logger.warn({ event: 'lock_conflict', type });
  }
}
