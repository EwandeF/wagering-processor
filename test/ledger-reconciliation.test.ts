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

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(balance: string): Promise<{ id: string; playerId: string }> {
  const res = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: uid(), initialBalance: money(balance) }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; playerId: string }>;
}

function bet(w: { id: string; playerId: string }, amount = '1.00') {
  const ext = uid();
  return fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `prov:${ext}` },
    body: JSON.stringify({
      providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
      roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: money(amount),
    }),
  });
}

const reconcile = (walletId: string) =>
  fetch(`${url}/wallets/${walletId}/reconciliation`, { method: 'POST' });

interface LedgerItem {
  id: string;
  direction: string;
  money: { amount: string };
  balanceBefore: { amount: string };
  balanceAfter: { amount: string };
}

async function walk(walletId: string, limit: number) {
  const items: LedgerItem[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const qs: string = `limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
    const res: Response = await fetch(`${url}/wallets/${walletId}/ledger?${qs}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: LedgerItem[]; nextCursor: string | null };
    items.push(...body.items);
    sizes.push(body.items.length);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return { items, sizes };
}

/** Cada lançamento parte do saldo em que o anterior terminou. */
function expectChain(items: LedgerItem[]) {
  expect(items[0]!.balanceBefore.amount).toBe('0.00');
  for (let i = 1; i < items.length; i++) {
    expect(items[i]!.balanceBefore.amount).toBe(items[i - 1]!.balanceAfter.amount);
  }
}

const ids = (items: LedgerItem[]) => items.map((i) => i.id);

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

describe('GET /wallets/:id/ledger', () => {
  test('pagina o ledger na ordem, sem repetir nem pular', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 7; i++) expect((await bet(w)).status).toBe(200);

    const { items, sizes } = await walk(w.id, 3);
    expect(sizes).toEqual([3, 3, 2]);
    expect(new Set(ids(items)).size).toBe(8);
    expect(items[0]).toMatchObject({ direction: 'CREDIT', money: { amount: '100.00' } });
    expect(items.slice(1).every((i) => i.direction === 'DEBIT')).toBe(true);
    expect(items[7]!.balanceAfter.amount).toBe('93.00');
    expectChain(items);
  });

  test('quando o total é múltiplo do limit, não existe página vazia no fim', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 7; i++) await bet(w);
    const { sizes } = await walk(w.id, 4);
    expect(sizes).toEqual([4, 4]);
  });

  test('o cursor é opaco e a última página devolve nextCursor nulo', async () => {
    const w = await createWallet('100.00');
    await bet(w);
    await bet(w);
    const first = (await (await fetch(`${url}/wallets/${w.id}/ledger?limit=2`)).json()) as {
      nextCursor: string | null;
    };
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const last = (await (
      await fetch(`${url}/wallets/${w.id}/ledger?limit=2&cursor=${first.nextCursor}`)
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  test('wallet sem lançamentos devolve lista vazia', async () => {
    const w = await createWallet('0.00');
    const body = await (await fetch(`${url}/wallets/${w.id}/ledger`)).json();
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  test('o cursor é estável: lançamentos novos só aparecem no fim', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 5; i++) await bet(w);

    const first = (await (await fetch(`${url}/wallets/${w.id}/ledger?limit=3`)).json()) as {
      items: LedgerItem[];
      nextCursor: string;
    };
    // Entre uma página e a outra, chegam 3 apostas ao mesmo tempo.
    await Promise.all([bet(w), bet(w), bet(w)]);

    const collected = [...first.items];
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const res: Response = await fetch(`${url}/wallets/${w.id}/ledger?limit=3&cursor=${cursor}`);
      const page = (await res.json()) as { items: LedgerItem[]; nextCursor: string | null };
      collected.push(...page.items);
      cursor = page.nextCursor;
    }

    const fresh = await walk(w.id, 50);
    expect(collected).toHaveLength(9);
    expect(ids(collected)).toEqual(ids(fresh.items));
    expect(new Set(ids(collected)).size).toBe(9);
    expectChain(collected);
  });

  test('paginar durante 40 apostas concorrentes: o que foi lido é prefixo do ledger final', async () => {
    const w = await createWallet('100.00');
    const writers = Promise.all(Array.from({ length: 40 }, () => bet(w)));
    const during = await walk(w.id, 7);
    await writers;
    const final = await walk(w.id, 50);

    expect(final.items).toHaveLength(41);
    expect(new Set(ids(during.items)).size).toBe(during.items.length);
    expect(ids(during.items)).toEqual(ids(final.items).slice(0, during.items.length));
    expectChain(final.items);
    expect(final.items[40]!.balanceAfter.amount).toBe('60.00');
  }, 30_000);

  test.each([
    ['texto solto', 'abc!'],
    ['vazio', ''],
    ['versão desconhecida', Buffer.from(JSON.stringify({ v: 2, s: '5' })).toString('base64url')],
    ['seq zero', Buffer.from(JSON.stringify({ v: 1, s: '0' })).toString('base64url')],
    ['seq numérico', Buffer.from(JSON.stringify({ v: 1, s: 5 })).toString('base64url')],
    ['não é JSON', Buffer.from('nao e json').toString('base64url')],
    ['grande demais', 'a'.repeat(101)],
  ])('cursor inválido (%s) é 400', async (_, cursor) => {
    const w = await createWallet('10.00');
    const res = await fetch(`${url}/wallets/${w.id}/ledger?cursor=${cursor}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  test.each(['0', '201', '-1', 'abc', '1.5', ''])('limit inválido (%p) é 400', async (limit) => {
    const w = await createWallet('10.00');
    expect((await fetch(`${url}/wallets/${w.id}/ledger?limit=${limit}`)).status).toBe(400);
  });

  test('wallet inexistente é 404 e id que não é UUID é 400', async () => {
    expect((await fetch(`${url}/wallets/${uid()}/ledger`)).status).toBe(404);
    expect((await fetch(`${url}/wallets/nao-e-uuid/ledger`)).status).toBe(400);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  test('wallet consistente: o formato do case', async () => {
    const w = await createWallet('1000.00');
    await bet(w, '25.00');
    const res = await reconcile(w.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      walletId: w.id,
      storedBalance: money('975.00'),
      calculatedBalance: money('975.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('wallet sem lançamentos é consistente com zero entradas', async () => {
    const w = await createWallet('0.00');
    expect(await (await reconcile(w.id)).json()).toMatchObject({
      consistent: true, checkedEntries: 0, calculatedBalance: money('0.00'),
    });
  });

  test('reconciliar durante 40 apostas concorrentes nunca acusa divergência falsa', async () => {
    const w = await createWallet('100.00');
    const writers = Promise.all(Array.from({ length: 40 }, () => bet(w)));
    const checks = await Promise.all(Array.from({ length: 15 }, () => reconcile(w.id)));
    await writers;

    for (const res of checks) {
      expect(res.status).toBe(200);
      expect(((await res.json()) as { consistent: boolean }).consistent).toBe(true);
    }
    expect(await (await reconcile(w.id)).json()).toMatchObject({
      consistent: true, checkedEntries: 41, storedBalance: money('60.00'),
    });
  }, 30_000);

  test('divergência: aparece na resposta e na métrica, e o saldo NÃO é corrigido', async () => {
    const w = await createWallet('100.00');
    const checksBefore = await metric('wager_reconciliation_checks_total');
    const divergencesBefore = await metric('wager_reconciliation_divergences_total');

    // Adultera o saldo guardado: o ledger é imutável, mas a wallet não.
    await orm.em
      .getConnection()
      .execute("update wallets set balance = 150.00 where id = ?", [w.id]);

    const res = await reconcile(w.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      storedBalance: money('150.00'),
      calculatedBalance: money('100.00'),
      difference: money('50.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(await metric('wager_reconciliation_checks_total')).toBe(checksBefore + 1);
    expect(await metric('wager_reconciliation_divergences_total')).toBe(divergencesBefore + 1);

    const after = await (await fetch(`${url}/wallets/${w.id}`)).json();
    expect(after).toMatchObject({ balance: money('150.00'), version: 1 });
  });

  test('ledger que soma negativo aparece como divergência, não como erro', async () => {
    const w = await createWallet('0.00');
    const txId = uid();
    const exec = (q: string, p: unknown[]) => orm.em.getConnection().execute(q, p);
    await exec(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status, processed_at, observed_balance)
       values (?, 'prov', ?, ?, 'h', ?, ?, 'r', 'g', 'WIN', 10.00, 'BRL', 'PROCESSED', now(), 0.00)`,
      [txId, uid(), uid(), w.id, w.playerId],
    );
    await exec(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values (?, ?, ?, 'DEBIT', 10.00, 'BRL', 10.00, 0.00)`,
      [uid(), w.id, txId],
    );

    const res = await reconcile(w.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      storedBalance: money('0.00'),
      calculatedBalance: money('-10.00'),
      difference: money('10.00'),
      consistent: false,
      checkedEntries: 1,
    });
  });

  test('wallet inexistente é 404 e id que não é UUID é 400', async () => {
    expect((await reconcile(uid())).status).toBe(404);
    expect((await reconcile('nao-e-uuid')).status).toBe(400);
  });
});

describe('GET /metrics', () => {
  test('expõe o formato Prometheus', async () => {
    const res = await fetch(`${url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE wager_reconciliation_checks_total counter');
    expect(text).toContain('# TYPE wager_reconciliation_divergences_total counter');
  });
});
