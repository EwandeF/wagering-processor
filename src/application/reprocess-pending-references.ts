import type { ReprocessOutcome } from './submit-wager-transaction';

export interface PendingReferenceFinder {
  /** Ids das transações em PENDING_REFERENCE cuja próxima checagem já chegou. */
  findDue(now: Date, limit: number): Promise<string[]>;
}

export interface ReprocessSummary {
  found: number;
  processed: number;
  rejected: number;
  expired: number;
  waiting: number;
  skipped: number;
  failed: number;
}

export class ReprocessPendingReferences {
  constructor(
    private readonly finder: PendingReferenceFinder,
    private readonly useCase: {
      reprocessPending(transactionId: string): Promise<ReprocessOutcome>;
    },
    private readonly clock: () => Date = () => new Date(),
    private readonly batchSize = 50,
    private readonly concurrency = 5,
    private readonly onFailure: (transactionId: string, error: unknown) => void = () => {},
  ) {}

  /**
   * Um ciclo. Seguro com vários workers ao mesmo tempo: se dois pegarem a mesma
   * transação, a wallet travada e a releitura garantem que só um aplica o efeito.
   */
  async runOnce(): Promise<ReprocessSummary> {
    const ids = await this.finder.findDue(this.clock(), this.batchSize);
    const summary: ReprocessSummary = {
      found: ids.length,
      processed: 0,
      rejected: 0,
      expired: 0,
      waiting: 0,
      skipped: 0,
      failed: 0,
    };

    for (let i = 0; i < ids.length; i += this.concurrency) {
      const chunk = ids.slice(i, i + this.concurrency);
      await Promise.all(
        chunk.map(async (id) => {
          try {
            summary[await this.useCase.reprocessPending(id)] += 1;
          } catch (error) {
            // Continua devida: entra de novo no próximo ciclo.
            summary.failed += 1;
            this.onFailure(id, error);
          }
        }),
      );
    }
    return summary;
  }
}
