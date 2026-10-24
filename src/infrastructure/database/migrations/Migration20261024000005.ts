import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000005 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions add column observed_balance numeric(19,2)
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_observed_balance_non_negative
          check (observed_balance >= 0),
        add constraint wager_tx_observed_balance_consistent
          check (status = 'PENDING' or observed_balance is not null)
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_tx_observed_balance_consistent,
        drop constraint wager_tx_observed_balance_non_negative
    `);
    this.addSql(`
      alter table wager_transactions drop column observed_balance
    `);
  }
}
