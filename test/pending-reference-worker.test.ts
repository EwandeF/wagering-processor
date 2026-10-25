import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type PendingReferenceFinder,
  ReprocessPendingReferences,
} from '../src/application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { type TestWallet, command, expectLedgerMatchesWallet, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;
let now = new Date();
const clock = () => now;
const tick = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm), clock);
});
afterAll(async () => {
  await orm.close(true);
});

async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as unknown as T[];
}

interface TxRow {
  id: string;
  status: string;
  failure_code: string | null;
  attempts: number;
  next: Date | null;
  ref: string | null;
}
const txRow = async (ext: string) =>
  (
    await sql<TxRow>(
      `select id, status, failure_code, reference_attempts as attempts,
              next_reference_attempt_at as next, reference_transaction_id as ref
         from wager_transactions where provider_id = 'prov' and external_transaction_id = ?`,
      [ext],
    )
  )[0]!;

const eventTypes = async (walletId: string) =>
  (
    await sql<{ event_type: string }>(
      'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, id',
      [walletId],
    )
  ).map((r) => r.event_type);

const pendingCount = async (walletId: string) =>
  (
    await sql<{ n: number }>(
      "select count(*)::int as n from wager_transactions where wallet_id = ? and status = 'PENDING_REFERENCE'",
      [walletId],
    )
  )[0]!.n;

/** Só enxerga as pendências das wallets do teste: o banco guarda sobras de outros testes. */
class ScopedFinder implements PendingReferenceFinder {
  constructor(private readonly walletIds: string[]) {}
  async findDue(at: Date, limit: number): Promise<string[]> {
    const marks = this.walletIds.map(() => '?').join(', ');
    const rows = await sql<{ id: string }>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
          and wallet_id in (${marks})
        order by next_reference_attempt_at, id limit ?`,
      [at, ...this.walletIds, limit],
    );
    return rows.map((r) => r.id);
  }
}

const workerFor = (wallets: TestWallet[]) =>
  new ReprocessPendingReferences(new ScopedFinder(wallets.map((w) => w.walletId)), submit, clock);

async function arrivePending(w: TestWallet, amount = '25.00') {
  const betExt = uid();
  const refundExt = uid();
  const r = await submit.execute(
    command(w, refundExt, Kind.Refund, amount, { referenceExternalTransactionId: betExt }),
  );
  expect(r.status).toBe(Status.PendingReference);
  return { betExt, refundExt, pendingId: r.transactionId };
}

describe('worker de referências pendentes', () => {
  test('a referência chega depois: a reversão é aplicada no ciclo devido', async () => {
    const w = await openWallet(orm, '100.00');
    const t0 = now;
    const { betExt, refundExt } = await arrivePending(w);
    const waiting = await txRow(refundExt);
    expect(new Date(waiting.next!).getTime() - t0.getTime()).toBe(5_000);
    expect(Number(waiting.attempts)).toBe(0);

    tick(1_000);
    await submit.execute(command(w, betExt, Kind.Bet, '25.00'));
    const worker = workerFor([w]);
    expect((await worker.runOnce()).found).toBe(0); // t0 + 1s: ainda não é a hora

    tick(4_000); // t0 + 5s
    expect(await worker.runOnce()).toMatchObject({ found: 1, processed: 1, failed: 0 });
    const row = await txRow(refundExt);
    expect(row).toMatchObject({ status: Status.Processed, failure_code: null, next: null });
    expect(row.ref).toBe((await txRow(betExt)).id);

    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
    const expected = [
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed', 'WalletBalanceChanged', // a BET
      'WagerTransactionProcessed', 'WalletBalanceChanged', // o REFUND aplicado pelo worker
    ];
    expect(await eventTypes(w.walletId)).toEqual(expected);

    // Um novo ciclo não acha mais nada e não repete eventos.
    expect((await worker.runOnce()).found).toBe(0);
    expect(await eventTypes(w.walletId)).toHaveLength(5);
  });

  test('a referência nunca chega: 12 checagens em ~1 hora e depois REFERENCE_NOT_FOUND', async () => {
    const w = await openWallet(orm, '100.00');
    const t0 = now;
    const { refundExt } = await arrivePending(w);
    const worker = workerFor([w]);

    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const due = new Date((await txRow(refundExt)).next!);
      now = new Date(due.getTime() - 1);
      expect((await worker.runOnce()).found).toBe(0); // 1 ms antes da hora, nada acontece
      now = due;
      const s = await worker.runOnce();
      expect(s.found).toBe(1);
      outcomes.push(s.expired ? 'expired' : s.waiting ? 'waiting' : 'outro');
    }
    expect(outcomes).toEqual([...Array.from({ length: 11 }, () => 'waiting'), 'expired']);
    expect(now.getTime() - t0.getTime()).toBe(3_635_000); // 60 min e 35 s

    const row = await txRow(refundExt);
    expect(row).toMatchObject({ status: Status.Rejected, failure_code: 'REFERENCE_NOT_FOUND', next: null });
    expect(Number(row.attempts)).toBe(12);
    expect(await eventTypes(w.walletId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s).toMatchObject({ balance: '100.00', version: 1, credits: 1, debits: 0 });
    expect((await worker.runOnce()).found).toBe(0);
  }, 30_000);

  test('a referência chega, mas a regra recusa: rejeitada com o código da regra', async () => {
    const w = await openWallet(orm, '100.00');
    const { betExt, refundExt } = await arrivePending(w, '10.00'); // BET será de 25.00
    tick(1_000);
    await submit.execute(command(w, betExt, Kind.Bet, '25.00'));
    tick(4_000);

    expect(await workerFor([w]).runOnce()).toMatchObject({ found: 1, rejected: 1 });
    expect(await txRow(refundExt)).toMatchObject({
      status: Status.Rejected, failure_code: 'REVERSAL_AMOUNT_MISMATCH', next: null,
    });
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('75.00');
    const types = await eventTypes(w.walletId);
    expect(types[types.length - 1]).toBe('WagerTransactionRejected');
  });

  test('cadeia ROLLBACK → REFUND → BET, tudo fora de ordem, converge', async () => {
    const w = await openWallet(orm, '100.00');
    const [betExt, refundExt, rollbackExt] = [uid(), uid(), uid()];
    const rb = await submit.execute(
      command(w, rollbackExt, Kind.Rollback, '25.00', { referenceExternalTransactionId: refundExt }),
    );
    tick(1_000);
    const rf = await submit.execute(
      command(w, refundExt, Kind.Refund, '25.00', { referenceExternalTransactionId: betExt }),
    );
    tick(1_000);
    await submit.execute(command(w, betExt, Kind.Bet, '25.00'));
    expect([rb.status, rf.status]).toEqual([Status.PendingReference, Status.PendingReference]);

    const worker = workerFor([w]);
    let cycles = 0;
    while (cycles < 6) {
      tick(10_000);
      cycles += 1;
      await worker.runOnce();
      if ((await pendingCount(w.walletId)) === 0) break;
    }
    expect(cycles).toBeLessThanOrEqual(3);
    expect((await txRow(refundExt)).status).toBe(Status.Processed);
    expect((await txRow(rollbackExt)).status).toBe(Status.Processed);
    // 100 - 25 (BET) + 25 (REFUND) - 25 (ROLLBACK do REFUND)
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s).toMatchObject({ balance: '75.00', debits: 2, credits: 2 });
  });
});

describe('worker: concorrência e falhas', () => {
  test('10 reprocessamentos simultâneos da mesma transação: um aplica, nove ignoram', async () => {
    const w = await openWallet(orm, '100.00');
    const { betExt, pendingId } = await arrivePending(w);
    tick(1_000);
    await submit.execute(command(w, betExt, Kind.Bet, '25.00'));
    tick(4_000);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => submit.reprocessPending(pendingId)),
    );
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(9);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
    expect(await eventTypes(w.walletId)).toHaveLength(5);
  });

  test('4 workers disputando 20 pendentes: cada reversão é aplicada exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(orm, '100.00')));
    const pending = await Promise.all(wallets.map(async (w) => ({ w, ...(await arrivePending(w)) })));
    tick(1_000);
    await Promise.all(pending.map((p) => submit.execute(command(p.w, p.betExt, Kind.Bet, '25.00'))));
    tick(5_000);

    const summaries = await Promise.all(
      Array.from({ length: 4 }, () => workerFor(wallets).runOnce()),
    );
    expect(summaries.reduce((n, s) => n + s.processed, 0)).toBe(20);
    expect(summaries.reduce((n, s) => n + s.failed, 0)).toBe(0);
    for (const w of wallets) {
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
      expect(await eventTypes(w.walletId)).toHaveLength(5);
    }
  }, 60_000);

  test('a falha de uma transação não derruba o ciclo, e ela continua devida', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => openWallet(orm, '100.00')));
    const pending = await Promise.all(wallets.map(async (w) => ({ w, ...(await arrivePending(w)) })));
    tick(1_000);
    await Promise.all(pending.map((p) => submit.execute(command(p.w, p.betExt, Kind.Bet, '25.00'))));
    tick(5_000);

    const bad = pending[0]!.pendingId;
    const failures: string[] = [];
    const flaky = {
      reprocessPending: async (id: string) => {
        if (id === bad) throw new Error('banco indisponível');
        return submit.reprocessPending(id);
      },
    };
    const finder = new ScopedFinder(wallets.map((w) => w.walletId));
    const first = await new ReprocessPendingReferences(
      finder, flaky, clock, 50, 5, (id) => failures.push(id),
    ).runOnce();
    expect(first).toMatchObject({ found: 3, processed: 2, failed: 1 });
    expect(failures).toEqual([bad]);

    const second = await new ReprocessPendingReferences(finder, submit, clock).runOnce();
    expect(second).toMatchObject({ found: 1, processed: 1, failed: 0 });
    for (const w of wallets) {
      expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
    }
  }, 30_000);

  test('ids inexistentes, já resolvidos ou ainda não devidos são ignorados', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await submit.execute(command(w, uid(), Kind.Bet, '25.00'));
    expect(await submit.reprocessPending(uid())).toBe('skipped');
    expect(await submit.reprocessPending(bet.transactionId)).toBe('skipped');

    const { pendingId } = await arrivePending(w);
    expect(await submit.reprocessPending(pendingId)).toBe('skipped'); // devida só daqui a 5s
    expect(await pendingCount(w.walletId)).toBe(1);
  });
});
