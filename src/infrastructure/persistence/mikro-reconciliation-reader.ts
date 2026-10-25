import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  ReconciliationReader,
  ReconciliationSnapshot,
} from '../../application/reconcile-wallet';

export class MikroReconciliationReader implements ReconciliationReader {
  constructor(private readonly orm: MikroORM) {}

  async read(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // Uma única consulta: saldo e ledger saem do mesmo snapshot do Postgres,
    // então apostas concorrentes não geram divergência falsa.
    const rows = (await this.orm.em.getConnection().execute(
      `select w.currency as currency,
              w.balance::text as stored,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
                ::numeric(19,2)::text as calculated,
              count(l.id)::int as checked
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    )) as unknown as { currency: string; stored: string; calculated: string; checked: number }[];

    const row = rows[0];
    if (!row) return undefined;
    return {
      currency: row.currency,
      storedBalance: row.stored,
      calculatedBalance: row.calculated,
      checkedEntries: Number(row.checked),
    };
  }
}
