import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { createSqsClient, sqsEndpoint } from '../src/infrastructure/sqs/sqs-client';
import {
  type E2eQueues,
  type RunningApp,
  bootFullApp,
  createE2eQueues,
  quarantineLeftovers,
  waitFor,
} from './e2e-helpers';
import { openWallet, uid } from './helpers';
import { wagerMessage } from './queue-helpers';

const sqs = createSqsClient();
let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});
afterAll(async () => {
  await orm.close(true);
});

const scrape = async (url: string) => (await fetch(`${url}/metrics`)).text();

/** Valor de uma série; as etiquetas pedidas precisam estar presentes (a ordem não importa). */
function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const m = line.match(/^([a-z_:]+)(?:\{(.*)\})? (\S+)$/);
    if (!m || m[1] !== name) continue;
    const found: Record<string, string> = {};
    for (const [, k, v] of (m[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) found[k!] = v!;
    if (Object.entries(labels).every(([k, v]) => found[k] === v)) return Number(m[3]);
  }
  return 0;
}

async function waitMetric(
  url: string,
  name: string,
  labels: Record<string, string>,
  ok: (value: number) => boolean,
  ms = 40_000,
) {
  await waitFor(async () => ok(metricValue(await scrape(url), name, labels)), ms);
}

const send = (q: E2eQueues, body: unknown, group: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: q.inUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: uid(),
    }),
  );

/** Filas próprias, sobras do banco em quarentena e um app inteiro com os workers ligados. */
async function scenario(
  body: (ctx: { queues: E2eQueues; app: RunningApp }) => Promise<void>,
  opts: { brokenEvents?: boolean } = {},
): Promise<void> {
  const queues = await createE2eQueues();
  // Uma fila de eventos que não existe: o publisher não consegue publicar nada.
  const effective: E2eQueues = opts.brokenEvents
    ? { ...queues, eventsUrl: `${sqsEndpoint()}/000000000000/nao-existe-${uid().slice(-8)}.fifo` }
    : queues;
  let app: RunningApp | undefined;
  try {
    await quarantineLeftovers(orm);
    app = await bootFullApp(effective);
    await body({ queues, app });
  } finally {
    await app?.app.close().catch(() => {});
    await orm.em.getConnection().execute('update outbox_messages set published_at = now() where published_at is null');
    await queues.remove();
  }
}

describe('métricas com os workers rodando de verdade', () => {
  test('mensagem processada: contadores do consumidor e do publisher, e a outbox esvazia', async () => {
    await scenario(async ({ queues, app }) => {
      const w = await openWallet(orm, '100.00');
      await send(queues, wagerMessage(w, uid(), Kind.Bet, '25.00'), w.walletId);

      await waitMetric(app.url, 'wager_outbox_published_total', {}, (v) => v >= 2);
      await waitMetric(app.url, 'wager_outbox_pending', {}, (v) => v === 0);

      const text = await scrape(app.url);
      expect(metricValue(text, 'wager_consumer_messages_total', { result: 'processed' })).toBe(1);
      expect(metricValue(text, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
      expect(metricValue(text, 'wager_outbox_published_total')).toBe(2);
      expect(metricValue(text, 'wager_outbox_publish_failures_total')).toBe(0);
      expect(metricValue(text, 'wager_outbox_lag_seconds')).toBe(0);
      expect(metricValue(text, 'wager_dlq_messages_total', { reason: 'permanent' })).toBe(0);
    });
  }, 90_000);

  test('a mesma mensagem duas vezes: uma processada e uma duplicata da inbox', async () => {
    await scenario(async ({ queues, app }) => {
      const w = await openWallet(orm, '100.00');
      const msg = wagerMessage(w, uid(), Kind.Bet, '25.00');
      await send(queues, msg, w.walletId);
      await send(queues, msg, w.walletId);

      await waitMetric(app.url, 'wager_consumer_messages_total', { result: 'duplicate_message' }, (v) => v >= 1);
      const text = await scrape(app.url);
      expect(metricValue(text, 'wager_consumer_messages_total', { result: 'processed' })).toBe(1);
      expect(metricValue(text, 'wager_consumer_messages_total', { result: 'duplicate_message' })).toBe(1);
      expect(metricValue(text, 'wager_duplicates_total', { source: 'inbox' })).toBe(1);
      expect(metricValue(text, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    });
  }, 90_000);

  test('JSON inválido vai para a DLQ e é contado como erro permanente', async () => {
    await scenario(async ({ queues, app }) => {
      const marker = `lixo-${uid()}`;
      await send(queues, `{"nao e json ${marker}`, marker);

      await waitMetric(app.url, 'wager_dlq_messages_total', { reason: 'permanent' }, (v) => v >= 1);
      const text = await scrape(app.url);
      expect(metricValue(text, 'wager_dlq_messages_total', { reason: 'permanent' })).toBe(1);
      expect(metricValue(text, 'wager_dlq_messages_total', { reason: 'max-attempts' })).toBe(0);
      expect(metricValue(text, 'wager_consumer_messages_total', { result: 'processed' })).toBe(0);
    });
  }, 90_000);

  test('publisher sem conseguir publicar: falhas sobem, nada é publicado e o lag cresce', async () => {
    await scenario(async ({ queues, app }) => {
      const w = await openWallet(orm, '100.00');
      await send(queues, wagerMessage(w, uid(), Kind.Bet, '25.00'), w.walletId);

      await waitMetric(app.url, 'wager_outbox_publish_failures_total', {}, (v) => v >= 2);
      await waitMetric(app.url, 'wager_outbox_lag_seconds', {}, (v) => v >= 1);

      const text = await scrape(app.url);
      expect(metricValue(text, 'wager_consumer_messages_total', { result: 'processed' })).toBe(1);
      expect(metricValue(text, 'wager_outbox_published_total')).toBe(0);
      expect(metricValue(text, 'wager_outbox_pending')).toBeGreaterThanOrEqual(2);
      expect(metricValue(text, 'wager_outbox_lag_seconds')).toBeGreaterThanOrEqual(1);
    }, { brokenEvents: true });
  }, 90_000);
});
