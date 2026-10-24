import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table wallet_ledger_entries (
        id             uuid primary key,
        wallet_id      uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction      text not null,
        amount         numeric(19,2) not null,
        currency       char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after  numeric(19,2) not null,
        created_at     timestamptz not null default now(),

        constraint ledger_one_entry_per_wallet_tx unique (wallet_id, transaction_id),
        constraint ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint ledger_balances_non_negative check (
          balance_before >= 0 and balance_after >= 0
        ),
        constraint ledger_is_balanced check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or
          (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      )
    `);

    // Paginação por cursor estável: ordena por (wallet_id, id).
    this.addSql(`
      create index ledger_wallet_id_idx on wallet_ledger_entries (wallet_id, id)
    `);

    // Imutabilidade: o banco recusa UPDATE, DELETE e TRUNCATE.
    this.addSql(`
      create function ledger_forbid_changes() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries é imutável: % não é permitido', tg_op
          using errcode = 'restrict_violation';
      end;
      $$ language plpgsql
    `);

    this.addSql(`
      create trigger ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_changes()
    `);

    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function ledger_forbid_changes()
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop function ledger_forbid_changes()');
  }
}
