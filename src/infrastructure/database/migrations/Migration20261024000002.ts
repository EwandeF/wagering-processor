import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       text not null,
        external_transaction_id           text not null,
        idempotency_key                   text not null,
        payload_hash                      text not null,
        wallet_id                         uuid not null references wallets (id),
        player_id                         uuid not null,
        round_id                          text not null,
        game_id                           text not null,
        kind                              text not null,
        amount                            numeric(19,2) not null,
        currency                          char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id          uuid references wager_transactions (id),
        status                            text not null default 'PENDING',
        failure_code                      text,
        created_at                        timestamptz not null default now(),
        processed_at                      timestamptz,

        constraint wager_tx_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_tx_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_kind_valid check (
          kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')
        ),
        constraint wager_tx_status_valid check (
          status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')
        ),
        constraint wager_tx_amount_non_negative check (amount >= 0),
        constraint wager_tx_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_reference_required check (
          (kind in ('REFUND','ROLLBACK')) = (reference_external_transaction_id is not null)
        ),
        constraint wager_tx_failure_code_consistent check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        ),
        constraint wager_tx_processed_at_consistent check (
          (status = 'PROCESSED') = (processed_at is not null)
        )
      )
    `);

    // Uma referência só pode ser revertida uma vez por tipo de operação.
    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
    `);

    // O worker de referências ausentes só olha as pendentes.
    this.addSql(`
      create index wager_tx_pending_reference
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create index wager_tx_wallet on wager_transactions (wallet_id, created_at)
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop table wager_transactions');
  }
}
