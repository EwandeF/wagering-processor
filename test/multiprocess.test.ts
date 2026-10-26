import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { createSqsClient } from '../src/infrastructure/sqs/sqs-client';
import {
  type E2eQueues,
  createE2eQueues,
  quarantineLeftovers,
  readEvents,
  waitFor,
} from './e2e-helpers';
import { type TestWallet, expectLedgerMatchesWallet, openWallet, uid } from './helpers';
import { type AppProcess, spawnApp } from './process-helpers';
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
    new ReceiveMessageCommand({ QueueUrl: q.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 1 }),
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

/** Filas próprias, sobras do banco em quarentena e N processos de verdade, sempre derrubados no fim. */
async function scenario(
  processes: number,
  body: (ctx: { queues: E2eQueues; apps: AppProcess[] }) => Promise<void>,
): Promise<void> {
  const queues = await createE2eQueues();
  const apps: AppProcess[] = [];
  try {
    await quarantineLeftovers(orm);
    for (let i = 0; i < processes; i++) apps.push(await spawnApp(queues));
    await body({ queues, apps });
  } finally {
    await Promise.all(apps.map((a) => a.stop('SIGKILL')));
    await queues.remove();
  }
}

const post = (url: string, payload: object, key: string) =>
  fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload),
  });

const betPayload = (w: TestWallet, ext: string, amount: string) => ({
  providerId: 'prov',
  externalTransactionId: ext,
  playerId: w.playerId,
  walletId: w.walletId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount, currency: 'BRL' },
});

const nth = (apps: AppProcess[], i: number) => apps[i % apps.length]!;

describe('3 processos de verdade, sem nada em comum além do banco e da fila', () => {
  test('SIGTERM real no meio do processamento: termina o que começou, sem transação pela metade', async () => {
    await scenario(1, async ({ queues, apps }) => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, '100.00')));
      const ids = wallets.map((w) => w.walletId);
      await Promise.all(
        wallets.flatMap((w) =>
          Array.from({ length: 4 }, () => send(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId)),
        ),
      );
      await waitFor(async () => (await betsCount(ids)) >= 1, 60_000);

      const t0 = Date.now();
      apps[0]!.proc.kill(15); // sinal de verdade, como faria o orquestrador
      await apps[0]!.proc.exited;
      const took = Date.now() - t0;
      console.log(`SIGTERM no meio do processamento: saiu em ${took} ms (signalCode=${apps[0]!.proc.signalCode})`);

      expect(apps[0]!.proc.signalCode === 'SIGTERM' || apps[0]!.proc.exitCode === 0).toBe(true);
      expect(took).toBeLessThan(20_000);

      // Nenhuma transação ficou pela metade: saldo, ledger, inbox e outbox andam juntos.
      for (const w of wallets) {
        await expectLedgerMatchesWallet(orm, w.walletId);
      }
      const done = await betsCount(ids);
      const events = (
        await rows<{ n: number }>(
          `select count(*)::int as n from outbox_messages where aggregate_id in (${marks(ids)}) and event_type = 'WagerTransactionProcessed' and payload->'data'->>'kind' = 'BET'`,
          ids,
        )
      )[0]!.n;
      expect(events).toBe(done);
      expect(done).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  test('cenário obrigatório: duas apostas de 80 em processos diferentes, em 15 wallets', async () => {
    await scenario(3, async ({ apps }) => {
      const wallets = await Promise.all(Array.from({ length: 15 }, () => openWallet(orm, '100.00')));
      const responses = await Promise.all(
        wallets.flatMap((w, i) =>
          [0, 1].map(async (k) => {
            const ext = uid();
            const res = await post(nth(apps, i + k).url, betPayload(w, ext, '80.00'), `prov:${ext}`);
            return { wallet: w.walletId, status: res.status };
          }),
        ),
      );

      for (const w of wallets) {
        const statuses = responses.filter((r) => r.wallet === w.walletId).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 422]);
        const s = await expectLedgerMatchesWallet(orm, w.walletId);
        expect(s).toMatchObject({ balance: '20.00', debits: 1 });
      }
    });
  }, 120_000);

  test('a mesma aposta 50 vezes, em rodízio entre os processos: um único débito', async () => {
    await scenario(3, async ({ apps }) => {
      const w = await openWallet(orm, '100.00');
      const ext = uid();
      const payload = betPayload(w, ext, '25.00');
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) => post(nth(apps, i).url, payload, `prov:${ext}`)),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
        transactionId: string;
        idempotentReplay: boolean;
      }[];
      expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
      expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s).toMatchObject({ balance: '75.00', debits: 1 });
    });
  }, 120_000);

  test('kill -9 de um processo no meio do consumo: os outros assumem, nada se perde nem duplica', async () => {
    await scenario(3, async ({ queues, apps }) => {
      const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet(orm, '100.00')));
      const ids = wallets.map((w) => w.walletId);
      const total = wallets.length * 5;
      await Promise.all(
        wallets.flatMap((w) =>
          Array.from({ length: 5 }, () => send(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId)),
        ),
      );

      await waitFor(async () => (await betsCount(ids)) >= 5, 60_000);
      await apps[0]!.stop('SIGKILL'); // morte súbita: sem commit, sem ack, sem limpeza
      expect(await betsCount(ids)).toBeLessThan(total);

      await waitFor(async () => (await walletsWithBalance(ids, '50.00')) === 12, 120_000);
      for (const w of wallets) {
        const s = await expectLedgerMatchesWallet(orm, w.walletId);
        expect(s).toMatchObject({ balance: '50.00', debits: 5 });
      }
      expect(await betsCount(ids)).toBe(total);

      // Os eventos do processo morto não se perderam: a outbox continuou pendente e outro processo publicou.
      const { distinct } = await readEvents(queues.eventsUrl, total * 2, 2_000);
      expect(distinct.size).toBe(total * 2);
      await waitFor(async () => (await unpublished(ids)) === 0, 60_000);
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 240_000);

  test('reinício do serviço: tudo desligado e religado, e a consistência final é comprovada', async () => {
    await scenario(3, async ({ queues, apps }) => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, '100.00')));
      const ids = wallets.map((w) => w.walletId);
      const wave = () =>
        Promise.all(
          wallets.flatMap((w) =>
            Array.from({ length: 3 }, () => send(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId)),
          ),
        );

      await wave();
      await waitFor(async () => (await walletsWithBalance(ids, '70.00')) === 10, 90_000);

      await Promise.all(apps.map((a) => a.stop('SIGTERM'))); // desligamento educado de todos
      expect(apps.every((a) => a.proc.exitCode !== null || a.proc.signalCode !== null)).toBe(true);

      const reborn = await Promise.all([spawnApp(queues), spawnApp(queues), spawnApp(queues)]);
      apps.splice(0, apps.length, ...reborn);

      await wave();
      await waitFor(async () => (await walletsWithBalance(ids, '40.00')) === 10, 90_000);

      // Quem comprova é o próprio serviço, por um processo novo.
      for (const [i, w] of wallets.entries()) {
        const res = await fetch(`${nth(apps, i).url}/wallets/${w.walletId}/reconciliation`, { method: 'POST' });
        expect(await res.json()).toMatchObject({ consistent: true, checkedEntries: 7 });
        const s = await expectLedgerMatchesWallet(orm, w.walletId);
        expect(s).toMatchObject({ balance: '40.00', debits: 6 });
      }

      const { distinct } = await readEvents(queues.eventsUrl, 120, 2_000);
      expect(distinct.size).toBe(120);
      await waitFor(async () => (await unpublished(ids)) === 0, 60_000);
      expect(await dlqIsEmpty(queues)).toBe(true);
    });
  }, 300_000);
});
