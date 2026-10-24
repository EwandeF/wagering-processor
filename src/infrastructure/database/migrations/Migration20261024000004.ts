import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000004 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id    text not null,
        payload_hash  text not null,
        received_at   timestamptz not null default now(),
        processed_at  timestamptz,

        primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id              uuid primary key,
        aggregate_id    uuid not null,
        event_type      text not null,
        payload         jsonb not null,
        occurred_at     timestamptz not null,
        attempts        integer not null default 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,

        constraint outbox_attempts_non_negative check (attempts >= 0),
        constraint outbox_payload_is_object check (jsonb_typeof(payload) = 'object')
      )
    `);

    // O publisher só varre o que ainda não foi publicado, na ordem de chegada.
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (occurred_at, id)
        where published_at is null
    `);

    this.addSql(`
      create index outbox_aggregate_idx on outbox_messages (aggregate_id, occurred_at)
    `);
  }

  async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
  }
}
