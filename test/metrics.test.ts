import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ORM } from '../src/infrastructure/tokens';
import { uid } from './helpers';

let app: INestApplication;
let url: string;
let orm: MikroORM;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  orm = app.get<MikroORM>(ORM, { strict: false });
});
afterAll(async () => {
  await app.close();
});

const scrape = async () => (await fetch(`${url}/metrics`)).text();

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

async function newWallet() {
  const res = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: uid(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  return (await res.json()) as { id: string; playerId: string };
}

type W = Awaited<ReturnType<typeof newWallet>>;

const body = (w: W, ext: string, kind: string, amount: string, extra: object = {}) => ({
  providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
  roundId: 'r1', gameId: 'g1', kind, money: { amount, currency: 'BRL' }, ...extra,
});

const post = (payload: { externalTransactionId: string }) =>
  fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `prov:${payload.externalTransactionId}` },
    body: JSON.stringify(payload),
  });

const FAMILIES = [
  'wager_transactions_total',
  'wager_duplicates_total',
  'wager_processing_duration_seconds',
  'wager_wallet_lock_wait_seconds',
  'wager_lock_conflicts_total',
  'wager_consumer_messages_total',
  'wager_consumer_retries_total',
  'wager_dlq_messages_total',
  'wager_outbox_published_total',
  'wager_outbox_publish_failures_total',
  'wager_outbox_pending',
  'wager_outbox_lag_seconds',
  'wager_pending_reference_total',
  'wager_reconciliation_checks_total',
  'wager_reconciliation_divergences_total',
];

describe('métricas expostas em /metrics', () => {
  test('todas as famílias exigidas pelo case existem', async () => {
    const text = await scrape();
    for (const family of FAMILIES) expect(text).toContain(`# TYPE ${family} `);
  });

  test('transação processada: contador por status e tipo, e latência', async () => {
    const w = await newWallet();
    const before = await scrape();
    expect((await post(body(w, uid(), 'BET', '10.00'))).status).toBe(200);
    const after = await scrape();

    const delta = (name: string, labels: Record<string, string> = {}) =>
      metricValue(after, name, labels) - metricValue(before, name, labels);
    expect(delta('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    expect(delta('wager_processing_duration_seconds_count', { status: 'PROCESSED' })).toBe(1);
    expect(delta('wager_wallet_lock_wait_seconds_count')).toBe(1);
  });

  test('transação rejeitada e transação à espera da referência', async () => {
    const w = await newWallet();
    const before = await scrape();
    await post(body(w, uid(), 'BET', '999.00'));
    await post(body(w, uid(), 'REFUND', '10.00', { referenceExternalTransactionId: uid() }));
    const after = await scrape();

    expect(
      metricValue(after, 'wager_transactions_total', { status: 'REJECTED', kind: 'BET' }) -
        metricValue(before, 'wager_transactions_total', { status: 'REJECTED', kind: 'BET' }),
    ).toBe(1);
    expect(
      metricValue(after, 'wager_transactions_total', { status: 'PENDING_REFERENCE', kind: 'REFUND' }) -
        metricValue(before, 'wager_transactions_total', { status: 'PENDING_REFERENCE', kind: 'REFUND' }),
    ).toBe(1);
  });

  test('replay conta como duplicata e NÃO como transação nova', async () => {
    const w = await newWallet();
    const payload = body(w, uid(), 'BET', '10.00');
    await post(payload);
    const before = await scrape();
    await post(payload);
    await post(payload);
    const after = await scrape();

    expect(
      metricValue(after, 'wager_duplicates_total', { source: 'idempotency' }) -
        metricValue(before, 'wager_duplicates_total', { source: 'idempotency' }),
    ).toBe(2);
    expect(
      metricValue(after, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }) -
        metricValue(before, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }),
    ).toBe(0);
  });

  test('20 envios simultâneos da mesma aposta: 1 transação e 19 duplicatas', async () => {
    const w = await newWallet();
    const payload = body(w, uid(), 'BET', '10.00');
    const before = await scrape();
    await Promise.all(Array.from({ length: 20 }, () => post(payload)));
    const after = await scrape();

    expect(
      metricValue(after, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }) -
        metricValue(before, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }),
    ).toBe(1);
    expect(
      metricValue(after, 'wager_duplicates_total', { source: 'idempotency' }) -
        metricValue(before, 'wager_duplicates_total', { source: 'idempotency' }),
    ).toBe(19);
  });

  test('outbox lag: sobe com eventos pendentes e volta a zero quando tudo é publicado', async () => {
    const exec = (q: string) => orm.em.getConnection().execute(q);
    await exec('update outbox_messages set published_at = now() where published_at is null');

    const w = await newWallet();
    await post(body(w, uid(), 'BET', '10.00')); // dois eventos novos, sem publisher ligado
    await Bun.sleep(1_100);

    const pending = await scrape();
    expect(metricValue(pending, 'wager_outbox_pending')).toBeGreaterThanOrEqual(2);
    expect(metricValue(pending, 'wager_outbox_lag_seconds')).toBeGreaterThanOrEqual(1);

    await exec('update outbox_messages set published_at = now() where published_at is null');
    const drained = await scrape();
    expect(metricValue(drained, 'wager_outbox_pending')).toBe(0);
    expect(metricValue(drained, 'wager_outbox_lag_seconds')).toBe(0);
  });

  test('o scrape não expõe valores monetários nem ids em etiquetas', async () => {
    const w = await newWallet();
    await post(body(w, uid(), 'BET', '12.34'));
    const text = await scrape();
    expect(text).not.toContain('12.34');
    expect(text).not.toContain(w.id);
    expect(text).not.toContain(w.playerId);
  });
});
