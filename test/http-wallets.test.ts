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

const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

describe('POST /wallets', () => {
  test('cria a wallet com saldo inicial e crédito OPENING no ledger', async () => {
    const playerId = uid();
    const res = await post('/wallets', { playerId, initialBalance: money('1000.00') });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ playerId, balance: money('1000.00'), version: 1 });

    const s = await expectLedgerMatchesWallet(orm, body.id);
    expect(s.balance).toBe('1000.00');
    expect(s.credits).toBe(1);
  });

  test('saldo inicial zero cria a wallet sem lançamento', async () => {
    const res = await post('/wallets', { playerId: uid(), initialBalance: money('0.00') });
    expect(res.status).toBe(201);
    const s = await expectLedgerMatchesWallet(orm, (await res.json()).id);
    expect(s.credits).toBe(0);
    expect(s.balance).toBe('0.00');
  });

  test('wallet duplicada para o mesmo jogador e moeda é 409', async () => {
    const playerId = uid();
    expect((await post('/wallets', { playerId, initialBalance: money('1.00') })).status).toBe(201);
    const res = await post('/wallets', { playerId, initialBalance: money('5.00') });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('o mesmo jogador pode ter wallets em moedas diferentes', async () => {
    const playerId = uid();
    expect((await post('/wallets', { playerId, initialBalance: money('1.00', 'BRL') })).status).toBe(201);
    expect((await post('/wallets', { playerId, initialBalance: money('1.00', 'USD') })).status).toBe(201);
  });

  test('10 criações concorrentes do mesmo jogador: uma 201 e nove 409', async () => {
    const playerId = uid();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/wallets', { playerId, initialBalance: money('10.00') })),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
  });

  test.each([
    ['amount com 1 casa', { playerId: uid(), initialBalance: money('10.5') }, 'INVALID_MONEY'],
    ['amount negativo', { playerId: uid(), initialBalance: money('-1.00') }, 'INVALID_MONEY'],
    ['amount em notação científica', { playerId: uid(), initialBalance: money('1e3') }, 'INVALID_MONEY'],
    ['moeda em minúsculas', { playerId: uid(), initialBalance: money('1.00', 'brl') }, 'INVALID_MONEY'],
    ['amount numérico', { playerId: uid(), initialBalance: { amount: 10, currency: 'BRL' } }, 'INVALID_MONEY'],
    ['playerId ausente', { initialBalance: money('1.00') }, 'INVALID_REQUEST'],
    ['playerId que não é UUID', { playerId: 'abc', initialBalance: money('1.00') }, 'INVALID_REQUEST'],
    ['initialBalance ausente', { playerId: uid() }, 'INVALID_REQUEST'],
    ['corpo que não é objeto', [1, 2], 'INVALID_REQUEST'],
  ])('payload inválido (%s) é 400', async (_, body, code) => {
    const res = await post('/wallets', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(code);
  });

  test('JSON malformado é 400 no formato padrão de erro', async () => {
    const res = await fetch(`${url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error.code).toBe('string');
  });
});

describe('GET /wallets/:walletId', () => {
  test('devolve a wallet', async () => {
    const created = await (await post('/wallets', { playerId: uid(), initialBalance: money('42.00') })).json();
    const res = await fetch(`${url}/wallets/${created.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  test('wallet inexistente é 404', async () => {
    const res = await fetch(`${url}/wallets/${uid()}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('WALLET_NOT_FOUND');
  });

  test('id que não é UUID é 400, não 500', async () => {
    const res = await fetch(`${url}/wallets/nao-e-uuid`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });

  test('rota inexistente também usa o formato padrão de erro', async () => {
    const res = await fetch(`${url}/nao-existe`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('health', () => {
  test('live e ready respondem 200', async () => {
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  });
});
