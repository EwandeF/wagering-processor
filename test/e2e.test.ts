import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { createSqsClient } from '../src/infrastructure/sqs/sqs-client';
import {
  type E2eQueues,
  type RunningApp,
  bootFullApp,
  createE2eQueues,
  quarantineLeftovers,
  readEvents,
  waitFor,
} from './e2e-helpers';
import { type TestWallet, expectLedgerMatchesWallet, openWallet, uid } from './helpers';
import { wagerMessage } from './queue-helpers';

const sqs = createSqsClient();
let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});
afterAll(async () => {
  await orm.close(true);
});

async function rows<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as unknown as T[];
}

const marks = (ids: string[]) => ids.map(() => '?').join(', ');

const balanceOf = async (walletId: string) =>
  (await rows<{ b: string }>('select balance::text as b from wallets where id = ?', [walletId]))[0]!.b;

const walletsWithBalance = async (ids: string[], balance: string) =>
  (
    await rows<{ n: number }>(
      `select count(*)::int as n from wallets where id in (${marks(ids)}) and balance = ?`,
      [...ids, balance],
    )
  )[0]!.n;

const betsCount = async (ids: string[]) =>
  (
    await rows<{ n: number }>(
      `select count(*)::int as n from wager_transactions where wallet_id in (${marks(ids)}) and kind = 'BET'`,
      ids,
    )
  )[0]!.n;

const unpublished = async (ids: string[]) =>
  (
    await rows<{ n: number }>(
      `select count(*)::int as n from outbox_messages where published_at is null and aggregate_id in (${marks(ids)})`,
      ids,
    )
  )[0]!.n;

async function dlqIsEmpty(q: E2eQueues): Promise<boolean> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: q.dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 1,
    }),
  );
  return (res.Messages ?? []).length === 0;
}

const send = (q: E2eQueues, body: unknown, group: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: q.inUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: uid(),
    }),
  );

/** Filas próprias, sobras do banco em quarentena e N instâncias do app ligadas. */
async function scenario(
  instances: number,
  body: (ctx: { queues: E2eQueues; apps: RunningApp[] }) => Promise<void>,
): Promise<void> {
  const queues = await createE2eQueues();
  const apps: RunningApp[] = [];
  try {
    await quarantineLeftovers(orm);
    for (let i = 0; i < instances; i++) apps.push(await bootFullApp(queues));
    await body({ queues, apps });
  } finally {
    await Promise.all(apps.map((a) => a.app.close().catch(() => {})));
    await queues.remove();
  }
}

const post = (url: string, payload: object, key: string) =>
  fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload),
  });

const httpTx = (w: TestWallet, ext: string, kind: string, amount: string, extra: object = {}) => ({
  providerId: 'prov',
  externalTransactionId: ext,
  playerId: w.playerId,
  walletId: w.walletId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount, currency: 'BRL' },
  ...extra,
});

describe('ponta a ponta, com os workers ligados', () => {
  test('mensagem na fila vira saldo e eventos publicados, na ordem', async () => {
    await scenario(1, async ({ queues }) => {
      const w = await openWallet(orm, '100.00');
      await send(queues, wagerMessage(w, uid(), Kind.Bet, '25.00'), w.walletId);

      await waitFor(async () => (await balanceOf(w.walletId)) === '75.00');
      const { distinct } = await readEvents(queues.eventsUrl, 2);
      const events = [...distinct.values()];

      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(events.every((e) => e.aggregateId === w.walletId)).toBe(true);
      expect(events[0]!.data).toMatchObject({
        status: 'PROCESSED', kind: 'BET', balance: { amount: '75.00', currency: 'BRL' },
      });
      expect(events[1]!.data).toMatchObject({
        direction: 'DEBIT', balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2,
      });

      await waitFor(async () => (await unpublished([w.walletId])) === 0);
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s.debits).toBe(1);
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 60_000);

  test('a referência chega depois e o worker fecha o saldo sozinho', async () => {
    await scenario(1, async ({ queues, apps }) => {
      const url = apps[0]!.url;
      const w = await openWallet(orm, '100.00');
      const [betExt, refundExt] = [uid(), uid()];

      const early = await post(
        url,
        httpTx(w, refundExt, 'REFUND', '25.00', { referenceExternalTransactionId: betExt }),
        `prov:${refundExt}`,
      );
      expect(early.status).toBe(202);
      const bet = await post(url, httpTx(w, betExt, 'BET', '25.00'), `prov:${betExt}`);
      expect(bet.status).toBe(200);
      expect(await balanceOf(w.walletId)).toBe('75.00');

      // Ninguém aciona nada: o worker procura a referência de novo, depois dos 5 s do agendamento.
      await waitFor(async () => (await balanceOf(w.walletId)) === '100.00', 40_000);

      const view = (await (
        await fetch(`${url}/providers/prov/wagering/transactions/${refundExt}`)
      ).json()) as { status: string };
      expect(view.status).toBe('PROCESSED');

      const { distinct } = await readEvents(queues.eventsUrl, 5);
      expect([...distinct.values()].map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 90_000);

  test('3 instâncias do app sobre 30 mensagens: cada uma uma vez, nenhum evento perdido', async () => {
    await scenario(3, async ({ queues }) => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, '100.00')));
      const ids = wallets.map((w) => w.walletId);
      await Promise.all(
        wallets.flatMap((w) =>
          [1, 2, 3].map(() => send(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId)),
        ),
      );

      await waitFor(async () => (await walletsWithBalance(ids, '70.00')) === 10, 50_000);
      for (const w of wallets) {
        const s = await expectLedgerMatchesWallet(orm, w.walletId);
        expect(s).toMatchObject({ balance: '70.00', debits: 3 });
      }

      const { distinct } = await readEvents(queues.eventsUrl, 60, 2_000);
      expect(distinct.size).toBe(60);
      const perWallet = new Map<string, number>();
      for (const e of distinct.values()) {
        perWallet.set(e.aggregateId, (perWallet.get(e.aggregateId) ?? 0) + 1);
      }
      expect([...perWallet.values()].every((n) => n === 6)).toBe(true);

      await waitFor(async () => (await unpublished(ids)) === 0);
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 120_000);

  test('desligar uma instância no meio do processamento: a outra assume, sem perder nem duplicar', async () => {
    await scenario(0, async ({ queues }) => {
      const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet(orm, '100.00')));
      const ids = wallets.map((w) => w.walletId);
      const total = wallets.length * 12;
      await Promise.all(
        wallets.flatMap((w) =>
          Array.from({ length: 12 }, () => send(queues, wagerMessage(w, uid(), Kind.Bet, '5.00'), w.walletId)),
        ),
      );

      const first = await bootFullApp(queues);
      await waitFor(async () => (await betsCount(ids)) >= 1, 30_000);

      const t0 = Date.now();
      await first.app.close(); // SIGTERM: termina o que começou e devolve o resto
      expect(Date.now() - t0).toBeLessThan(20_000);
      const doneByFirst = await betsCount(ids);
      expect(doneByFirst).toBeGreaterThanOrEqual(1);
      expect(doneByFirst).toBeLessThan(total); // senão o desligamento não interrompeu nada

      const second = await bootFullApp(queues);
      try {
        await waitFor(async () => (await walletsWithBalance(ids, '40.00')) === 8, 90_000);
        // O publisher da instância viva ainda precisa esvaziar a outbox: só depois ela pode ser desligada.
        await waitFor(async () => (await unpublished(ids)) === 0, 60_000);
      } finally {
        await second.app.close().catch(() => {});
      }

      for (const w of wallets) {
        const s = await expectLedgerMatchesWallet(orm, w.walletId);
        expect(s).toMatchObject({ balance: '40.00', debits: 12 });
      }
      expect(await betsCount(ids)).toBe(total);

      const { distinct } = await readEvents(queues.eventsUrl, total * 2, 2_000);
      expect(distinct.size).toBe(total * 2);
      expect(await unpublished(ids)).toBe(0);
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 180_000);
});
