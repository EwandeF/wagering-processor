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

async function newWallet() {
  const res = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: uid(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  return (await res.json()) as { id: string; playerId: string };
}

async function bet(w: { id: string; playerId: string }, headers: Record<string, string>) {
  const ext = uid();
  return fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `prov:${ext}`, ...headers },
    body: JSON.stringify({
      providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
      roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
    }),
  });
}

async function eventCorrelations(walletId: string): Promise<string[]> {
  const rows = (await orm.em
    .getConnection()
    .execute(
      "select payload->>'correlationId' as c from outbox_messages where aggregate_id = ? and event_type like 'WagerTransaction%' order by occurred_at, id",
      [walletId],
    )) as unknown as { c: string }[];
  return rows.map((r) => r.c);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('X-Correlation-Id', () => {
  test('um valor seguro volta na resposta e segue até o evento da outbox', async () => {
    const w = await newWallet();
    const res = await bet(w, { 'x-correlation-id': 'req-abc.123:xyz' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('req-abc.123:xyz');
    expect(await eventCorrelations(w.id)).toEqual(['req-abc.123:xyz']);
  });

  test('sem o header, o servidor gera um uuid e o propaga', async () => {
    const w = await newWallet();
    const res = await bet(w, {});
    const id = res.headers.get('x-correlation-id') ?? '';
    expect(id).toMatch(UUID);
    expect(await eventCorrelations(w.id)).toEqual([id]);
  });

  test.each([
    ['com espaços e aspas', 'x; "evil" level=ERROR'],
    ['grande demais', 'a'.repeat(101)],
    ['com barra', 'a/b'],
    ['com chaves', '{"level":"fake"}'],
  ])('valor inseguro (%s) é substituído por um uuid', async (_, value) => {
    const w = await newWallet();
    const res = await bet(w, { 'x-correlation-id': value });
    const id = res.headers.get('x-correlation-id') ?? '';
    expect(id).not.toBe(value);
    expect(id).toMatch(UUID);
    expect(await eventCorrelations(w.id)).toEqual([id]);
  });

  test('a replay com outro correlation id não repete eventos nem efeito', async () => {
    const w = await newWallet();
    const ext = uid();
    const send = (corr: string) =>
      fetch(`${url}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `prov:${ext}`, 'x-correlation-id': corr },
        body: JSON.stringify({
          providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
          roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
        }),
      });
    const first = await (await send('corr-1')).json();
    const second = (await (await send('corr-2')).json()) as { idempotentReplay: boolean; transactionId: string };
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await eventCorrelations(w.id)).toEqual(['corr-1']); // a segunda chamada não gerou evento
  });
});
