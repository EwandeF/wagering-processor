import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, OutboxBatchStore } from '../src/application/outbox-ports';
import { PublishOutbox } from '../src/application/publish-outbox';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import type { OutboxMessage } from '../src/domain/outbox-message';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroOutboxStore } from '../src/infrastructure/persistence/mikro-outbox-store';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { createSqsClient, sqsEndpoint } from '../src/infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '../src/infrastructure/sqs/sqs-event-publisher';
import { command, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;
let store: MikroOutboxStore;

const sqs = createSqsClient();
const queueName = `wager-events-test-${uid().slice(-12)}.fifo`;
const queueUrl = `${sqsEndpoint()}/000000000000/${queueName}`;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
  store = new MikroOutboxStore(orm);
  await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }));
});
afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await orm.close(true);
});

// Sobras de outros testes ficam marcadas como publicadas: cada teste vê só os seus eventos.
beforeEach(async () => {
  await orm.em
    .getConnection()
    .execute('update outbox_messages set published_at = now() where published_at is null');
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, params)) as unknown as T[];
}

const pending = async () =>
  (await rows<{ n: number }>('select count(*)::int as n from outbox_messages where published_at is null'))[0]!.n;

/** Publicador de mentira: registra o que "enviou", pode falhar e pode demorar. */
class ScriptedPublisher implements EventPublisher {
  ids: string[] = [];
  failing = false;
  delayMs = 0;
  async publish(message: OutboxMessage): Promise<void> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.failing) throw new Error('SQS indisponível');
    this.ids.push(message.id);
  }
}

/** Simula a morte do processo no meio do ciclo do publisher. */
class CrashingStore implements OutboxBatchStore {
  constructor(
    private readonly inner: OutboxBatchStore,
    private readonly when: 'before-publish' | 'after-publish',
  ) {}
  processDue<T>(now: Date, limit: number, work: (m: OutboxMessage[]) => Promise<T>): Promise<T> {
    return this.inner.processDue(now, limit, async (messages) => {
      if (this.when === 'before-publish') {
        throw new Error('processo morreu antes de publicar');
      }
      await work(messages);
      throw new Error('processo morreu depois de publicar, antes do commit');
    });
  }
}

async function betWithEvents() {
  const w = await openWallet(orm, '100.00');
  await submit.execute(command(w, uid(), Kind.Bet, '25.00'));
  return w;
}

async function receiveEvents(expected: number) {
  const seen = new Map<string, { eventType: string; groupId?: string }>();
  for (let i = 0; i < 8 && seen.size < expected; i++) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 2,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    for (const m of res.Messages ?? []) {
      const body = JSON.parse(m.Body ?? '{}');
      if (!seen.has(body.eventId)) {
        seen.set(body.eventId, { eventType: body.eventType, groupId: m.Attributes?.MessageGroupId });
      }
    }
  }
  return [...seen.values()];
}

describe('publisher: SQS de verdade', () => {
  test('publica os eventos da outbox no SQS e marca como publicados', async () => {
    const w = await betWithEvents();
    const relay = new PublishOutbox(store, new SqsEventPublisher(sqs, queueUrl));

    expect(await relay.runOnce()).toEqual({ claimed: 2, published: 2, failed: 0 });

    const received = await receiveEvents(2);
    expect(received.map((r) => r.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(received.every((r) => r.groupId === w.walletId)).toBe(true);

    const done = await rows<{ n: number }>(
      'select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is not null and attempts = 0',
      [w.walletId],
    );
    expect(done[0]!.n).toBe(2);
    expect(await pending()).toBe(0);
  }, 30_000);

  test('sem nada devido, o ciclo não faz nada', async () => {
    const relay = new PublishOutbox(store, new ScriptedPublisher());
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });
});

describe('publisher: falhas e retry', () => {
  test('falha agenda retry com backoff; respeita a hora; depois publica', async () => {
    const w = await betWithEvents();
    const publisher = new ScriptedPublisher();
    publisher.failing = true;
    const t0 = new Date();
    let now = t0;
    const failures: string[] = [];
    const relay = new PublishOutbox(store, publisher, () => now, 50, (m) => failures.push(m.id));

    expect(await relay.runOnce()).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(failures).toHaveLength(2);

    const after = await rows<{ attempts: number; due_in_ms: number; published: boolean }>(
      `select attempts,
              (extract(epoch from next_attempt_at) * 1000 - ?)::bigint as due_in_ms,
              published_at is not null as published
         from outbox_messages where aggregate_id = ?`,
      [t0.getTime(), w.walletId],
    );
    expect(after.map((r) => Number(r.attempts))).toEqual([1, 1]);
    expect(after.map((r) => Number(r.due_in_ms))).toEqual([1000, 1000]);
    expect(after.every((r) => r.published === false)).toBe(true);

    // Ainda dentro do backoff: nada é reservado.
    now = new Date(t0.getTime() + 500);
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });

    // Chegou a hora, e o serviço voltou: publica e para de tentar.
    publisher.failing = false;
    now = new Date(t0.getTime() + 1000);
    expect(await relay.runOnce()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(publisher.ids).toHaveLength(2);
    expect(await pending()).toBe(0);
  });

  test('falhas seguidas dobram o atraso', async () => {
    const w = await betWithEvents();
    const publisher = new ScriptedPublisher();
    publisher.failing = true;
    let now = new Date();
    const relay = new PublishOutbox(store, publisher, () => now);

    await relay.runOnce(); // tentativa 1: próxima em +1s
    now = new Date(now.getTime() + 1000);
    await relay.runOnce(); // tentativa 2: próxima em +2s
    const r = await rows<{ attempts: number }>(
      'select attempts from outbox_messages where aggregate_id = ?',
      [w.walletId],
    );
    expect(r.map((x) => Number(x.attempts))).toEqual([2, 2]);

    now = new Date(now.getTime() + 1999); // 1ms antes da hora
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
    now = new Date(now.getTime() + 1);
    expect((await relay.runOnce()).failed).toBe(2);
  });
});

describe('publisher: vários ao mesmo tempo', () => {
  test('4 publishers concorrentes sobre 40 eventos: cada um sai exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(orm, '100.00')));
    await Promise.all(wallets.map((w) => submit.execute(command(w, uid(), Kind.Bet, '10.00'))));
    expect(await pending()).toBe(40);

    const publisher = new ScriptedPublisher();
    publisher.delayMs = 5; // alarga a janela de sobreposição entre os publishers
    const relays = Array.from({ length: 4 }, () => new PublishOutbox(store, publisher, () => new Date(), 10));

    let rounds = 0;
    while ((await pending()) > 0 && rounds < 20) {
      await Promise.all(relays.map((r) => r.runOnce()));
      rounds += 1;
    }

    expect(publisher.ids).toHaveLength(40);
    expect(new Set(publisher.ids).size).toBe(40);
    expect(await pending()).toBe(0);
  }, 30_000);

  test('dois publishers no mesmo instante dividem o trabalho sem se bloquear', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, '100.00')));
    await Promise.all(wallets.map((w) => submit.execute(command(w, uid(), Kind.Bet, '10.00'))));

    const publisher = new ScriptedPublisher();
    publisher.delayMs = 20;
    const a = new PublishOutbox(store, publisher, () => new Date(), 10);
    const b = new PublishOutbox(store, publisher, () => new Date(), 10);

    const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
    // Cada um reservou um lote diferente: nenhum ficou parado esperando o outro.
    expect(ra.claimed).toBe(10);
    expect(rb.claimed).toBe(10);
    expect(new Set(publisher.ids).size).toBe(20);
    expect(publisher.ids).toHaveLength(20);
  }, 30_000);
});

describe('publisher: processo morto', () => {
  test('morre antes de publicar: outra instância assume, e o evento sai uma vez', async () => {
    await betWithEvents();
    const publisher = new ScriptedPublisher();

    const dying = new PublishOutbox(new CrashingStore(store, 'before-publish'), publisher);
    await expect(dying.runOnce()).rejects.toThrow('antes de publicar');
    expect(publisher.ids).toHaveLength(0);
    expect(await pending()).toBe(2); // a reserva foi liberada, nada se perdeu

    const takeover = new PublishOutbox(store, publisher);
    expect(await takeover.runOnce()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(publisher.ids).toHaveLength(2);
    expect(await pending()).toBe(0);
  });

  test('morre depois de publicar e antes do commit: sai de novo, com o mesmo eventId', async () => {
    await betWithEvents();
    const publisher = new ScriptedPublisher();

    const dying = new PublishOutbox(new CrashingStore(store, 'after-publish'), publisher);
    await expect(dying.runOnce()).rejects.toThrow('antes do commit');
    expect(publisher.ids).toHaveLength(2); // saiu, mas o commit não aconteceu
    expect(await pending()).toBe(2); // por isso o evento continua pendente

    const takeover = new PublishOutbox(store, publisher);
    await takeover.runOnce();
    expect(await pending()).toBe(0);

    // At-least-once: 4 envios, mas só 2 eventos distintos. O mesmo eventId é o que
    // permite ao consumidor (inbox) descartar a repetição.
    expect(publisher.ids).toHaveLength(4);
    expect(new Set(publisher.ids).size).toBe(2);
  });
});
