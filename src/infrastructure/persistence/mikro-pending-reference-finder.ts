import type { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferenceFinder } from '../../application/reprocess-pending-references';
import { WagerTransactionStatus } from '../../domain/enums';
import { WagerTransactionSchema } from './schemas';

export class MikroPendingReferenceFinder implements PendingReferenceFinder {
  constructor(private readonly orm: MikroORM) {}

  async findDue(now: Date, limit: number): Promise<string[]> {
    const records = await this.orm.em.fork().find(
      WagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: now },
      },
      { orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' }, limit },
    );
    return records.map((r) => r.id);
  }
}
