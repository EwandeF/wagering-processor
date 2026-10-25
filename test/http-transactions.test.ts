import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ORM } from '../src/infrastructure/tokens';
import { expectLedgerMatchesWallet, uid } from './helpers';

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

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

async function newWallet(balance = '100.00') {
  const res = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: uid(), initialBalance: money(balance) }),
  });
  const body = await res.json();
  return { walletId: body.id as string, playerId: body.playerId as string };
}

type W = Awaited<ReturnType<typeof newWallet>>;

const payload = (w: W, ext: string, kind: string, amount: string, extra: object = {}) => ({
  providerId: 'prov',
  externalTransactionId: ext,
  playerId: w.playerId,
  walletId: w.walletId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: money(amount),
  ...extra,
});

const submit = (body: object, key?: string | null) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const ext = (body as { externalTransactionId?: string }).externalTransactionId;
  if (key !== null) headers['idempotency-key'] = key ?? `prov:${ext}`;
  return fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
};

describe('POST /wagering/transactions: resultados', () => {
  test('BET processada: 200 e saldo debitado', async () => {
    const w = await newWallet();
    const res = await submit(payload(w, uid(), 'BET', '25.00'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'PROCESSED',
      balance: money('75.00'),
      idempotentReplay: false,
    });
    expect(typeof body.transactionId).toBe('string');
  });

  test('replay: 200 com o mesmo resultado e idempotentReplay true', async () => {
    const w = await newWallet();
    const body = payload(w, uid(), 'BET', '25.00');
    const first = await (await submit(body)).json();
    const res = await submit(body);
    expect(res.status).toBe(200);
    const replay = await res.json();
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(money('75.00'));
  });

  test('rejeição por regra de negócio: 422 com failureCode e providerAction', async () => {
    const w = await newWallet();
    const body = payload(w, uid(), 'BET', '500.00');
    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'RETRY_LATER',
      balance: money('100.00'),
    });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect((await replay.json()).idempotentReplay).toBe(true);
  });

  test('reversão antes da referência: 202 PENDING_REFERENCE', async () => {
    const w = await newWallet();
    const res = await submit(
      payload(w, uid(), 'REFUND', '25.00', { referenceExternalTransactionId: uid() }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: money('100.00'),
    });
  });

  test('REFUND com a referência presente é processado', async () => {
    const w = await newWallet();
    const betExt = uid();
    await submit(payload(w, betExt, 'BET', '25.00'));
    const res = await submit(
      payload(w, uid(), 'REFUND', '25.00', { referenceExternalTransactionId: betExt }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).balance).toEqual(money('100.00'));
  });
});

describe('POST /wagering/transactions: erros', () => {
  test('sem o header Idempotency-Key: 400', async () => {
    const w = await newWallet();
    const res = await submit(payload(w, uid(), 'BET', '10.00'), null);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });

  test('header em branco: 400', async () => {
    const w = await newWallet();
    expect((await submit(payload(w, uid(), 'BET', '10.00'), '   ')).status).toBe(400);
  });

  test('mesma key com payload diferente: 409', async () => {
    const w = await newWallet();
    const ext = uid();
    expect((await submit(payload(w, ext, 'BET', '25.00'))).status).toBe(200);
    const res = await submit(payload(w, ext, 'BET', '26.00'));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('o header manda: key igual com externalTransactionId diferente é conflito', async () => {
    const w = await newWallet();
    const key = `key-${uid()}`;
    expect((await submit(payload(w, uid(), 'BET', '10.00'), key)).status).toBe(200);
    expect((await submit(payload(w, uid(), 'BET', '10.00'), key)).status).toBe(409);
  });

  test.each([
    ['kind inexistente', (w: W) => payload(w, uid(), 'DEPOSIT', '10.00'), 'INVALID_REQUEST'],
    ['OPENING não pode ser submetido', (w: W) => payload(w, uid(), 'OPENING', '10.00'), 'INVALID_WAGER_TRANSACTION'],
    ['REFUND sem referência', (w: W) => payload(w, uid(), 'REFUND', '10.00'), 'INVALID_WAGER_TRANSACTION'],
    ['BET com referência', (w: W) => payload(w, uid(), 'BET', '10.00', { referenceExternalTransactionId: 'x' }), 'INVALID_WAGER_TRANSACTION'],
    ['valor com 1 casa', (w: W) => payload(w, uid(), 'BET', '10.5'), 'INVALID_MONEY'],
    ['valor zero em BET', (w: W) => payload(w, uid(), 'BET', '0.00'), 'INVALID_WAGER_TRANSACTION'],
    ['playerId inválido', (w: W) => payload(w, uid(), 'BET', '10.00', { playerId: 'x' }), 'INVALID_REQUEST'],
    ['providerId ausente', (w: W) => payload(w, uid(), 'BET', '10.00', { providerId: undefined }), 'INVALID_REQUEST'],
  ])('payload inválido (%s): 400', async (_, build, code) => {
    const w = await newWallet();
    const res = await submit(build(w));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(code);
  });

  test('wallet inexistente: 404', async () => {
    const ghost = { walletId: uid(), playerId: uid() };
    const res = await submit(payload(ghost, uid(), 'BET', '10.00'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('POST /wagering/transactions: concorrência via HTTP', () => {
  test('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const w = await newWallet('100.00');
    const [a, b] = await Promise.all([
      submit(payload(w, uid(), 'BET', '80.00')),
      submit(payload(w, uid(), 'BET', '80.00')),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);

    const walletRes = await (await fetch(`${url}/wallets/${w.walletId}`)).json();
    expect(walletRes.balance).toEqual(money('20.00'));
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
  });

  test('a mesma aposta enviada 50 vezes em paralelo: 50 respostas 200 e um débito', async () => {
    const w = await newWallet('100.00');
    const body = payload(w, uid(), 'BET', '25.00');
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
    expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);
    expect(bodies.every((b) => b.balance.amount === '75.00')).toBe(true);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
  }, 30_000);
});

describe('consultas de transação', () => {
  test('GET por id e GET por provedor + id externo devolvem a mesma transação', async () => {
    const w = await newWallet();
    const ext = uid();
    const created = await (await submit(payload(w, ext, 'BET', '25.00'))).json();

    const byId = await fetch(`${url}/wagering/transactions/${created.transactionId}`);
    expect(byId.status).toBe(200);
    const view = await byId.json();
    expect(view).toMatchObject({
      transactionId: created.transactionId,
      providerId: 'prov',
      externalTransactionId: ext,
      kind: 'BET',
      money: money('25.00'),
      status: 'PROCESSED',
      balance: money('75.00'),
    });

    const byExternal = await fetch(`${url}/providers/prov/wagering/transactions/${ext}`);
    expect(byExternal.status).toBe(200);
    expect(await byExternal.json()).toEqual(view);
  });

  test('transação rejeitada expõe failureCode e providerAction', async () => {
    const w = await newWallet();
    const ext = uid();
    await submit(payload(w, ext, 'BET', '999.00'));
    const view = await (await fetch(`${url}/providers/prov/wagering/transactions/${ext}`)).json();
    expect(view).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'RETRY_LATER',
    });
  });

  test('inexistente: 404; id que não é UUID: 400', async () => {
    const missing = await fetch(`${url}/wagering/transactions/${uid()}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await fetch(`${url}/providers/prov/wagering/transactions/nao-existe`)).status).toBe(404);
    expect((await fetch(`${url}/wagering/transactions/abc`)).status).toBe(400);
  });
});
