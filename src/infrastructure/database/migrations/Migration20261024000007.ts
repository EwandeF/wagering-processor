import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000007 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0,
        add column next_reference_attempt_at timestamptz
    `);
    // Quem já esperava referência passa a ser devido agora.
    this.addSql(`
      update wager_transactions set next_reference_attempt_at = now()
       where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_reference_attempts_non_negative
          check (reference_attempts >= 0),
        add constraint wager_tx_next_reference_consistent
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null))
    `);
    this.addSql('drop index wager_tx_pending_reference');
    this.addSql(`
      create index wager_tx_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop index wager_tx_reference_due');
    this.addSql(`
      create index wager_tx_pending_reference
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_tx_next_reference_consistent,
        drop constraint wager_tx_reference_attempts_non_negative
    `);
    this.addSql(`
      alter table wager_transactions
        drop column next_reference_attempt_at,
        drop column reference_attempts
    `);
  }
}
