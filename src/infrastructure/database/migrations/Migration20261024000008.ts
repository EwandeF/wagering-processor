import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000008 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create function wager_tx_guard() returns trigger as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions é auditável: % não é permitido', tg_op
            using errcode = 'restrict_violation';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transação % já está em % e não muda mais', old.id, old.status
            using errcode = 'restrict_violation';
        end if;

        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'transação % não pode voltar para PENDING', old.id
            using errcode = 'restrict_violation';
        end if;

        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id,
            new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id,
            old.created_at) then
          raise exception 'wager_transactions: campos de identidade são imutáveis'
            using errcode = 'restrict_violation';
        end if;

        return new;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wager_tx_guard_row
        before update or delete on wager_transactions
        for each row execute function wager_tx_guard()
    `);
    this.addSql(`
      create trigger wager_tx_guard_truncate
        before truncate on wager_transactions
        for each statement execute function wager_tx_guard()
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop trigger wager_tx_guard_truncate on wager_transactions');
    this.addSql('drop trigger wager_tx_guard_row on wager_transactions');
    this.addSql('drop function wager_tx_guard()');
  }
}
