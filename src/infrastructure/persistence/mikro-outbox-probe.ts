import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxProbeResult } from '../observability/metrics';

export class MikroOutboxProbe {
  constructor(private readonly orm: MikroORM) {}

  /** Pendentes e a idade do mais antigo. O índice parcial das não publicadas mantém isto barato. */
  read = async (): Promise<OutboxProbeResult> => {
    const rows = (await this.orm.em.getConnection().execute(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag
         from outbox_messages
        where published_at is null`,
    )) as unknown as { pending: number; lag: number }[];
    const row = rows[0];
    return { pending: Number(row?.pending ?? 0), lagSeconds: Number(row?.lag ?? 0) };
  };
}
