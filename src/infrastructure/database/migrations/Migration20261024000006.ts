import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000006 extends Migration {
  async up(): Promise<void> {
    this.addSql('drop index wager_tx_one_reversal_per_kind');
    // Uma transação só pode ser revertida uma vez, seja por REFUND ou ROLLBACK.
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop index wager_tx_one_reversal_per_reference');
    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
    `);
  }
}
