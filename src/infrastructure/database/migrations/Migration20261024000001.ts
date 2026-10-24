import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null,
        balance     numeric(19,2) not null,
        version     integer not null default 1,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),

        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency)
      )
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop table wallets');
  }
}
