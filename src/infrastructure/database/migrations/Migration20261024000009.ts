import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000009 extends Migration {
  async up(): Promise<void> {
    // Ordem de commit por wallet: os INSERTs de uma wallet são serializados pelo lock dela.
    this.addSql(`
      alter table wallet_ledger_entries add column seq bigint generated always as identity
    `);
    this.addSql(`
      create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq)
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop index ledger_wallet_seq_idx');
    this.addSql('alter table wallet_ledger_entries drop column seq');
  }
}
