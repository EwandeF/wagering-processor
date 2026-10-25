import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../src/application/open-wallet';
import type { WagerRepositories, WagerUnitOfWork } from '../src/application/ports';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { command, expectLedgerMatchesWallet, openWallet, uid } from './helpers';

interface OutboxRow {
  event_type: string;
  payload: {
    correlationId: string;
    causationId?: string;
    aggregateId: string;
    version: number;
    data: Record<string, any>;
  };
}

let orm: MikroORM;
let realUow: MikroWagerUnitOfWork;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  realUow = new MikroWagerUnitOfWork(orm);
  submit = new SubmitWagerTransaction(realUow);
});
afterAll(async () => {
  await orm.close(true);
});

async function outboxFor(walletId: string): Promise<OutboxRow[]> {
  return (await orm.em
    .getConnection()
    .execute(
      'select event_type, payload from outbox_messages where aggregate_id = ? order by occurred_at, id',
      [walletId],
    )) as unknown as OutboxRow[];
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = (await orm.em.getConnection().execute(sql, params)) as unknown as { n: number }[];
  return rows[0]!.n;
}

describe('eventos gravados junto com a mudança financeira', () => {
  test('BET processada: Processed e depois WalletBalanceChanged', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Bet, '25.00', { correlationId: 'corr-1' }));

    const rows = await outboxFor(w.walletId);
    expect(rows.map((x) => x.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const [processed, changed] = rows as [OutboxRow, OutboxRow];
    expect(processed.payload.correlationId).toBe('corr-1');
    expect(processed.payload.causationId).toBe(r.transactionId);
    expect(processed.payload.aggregateId).toBe(w.walletId);
    expect(processed.payload.data).toMatchObject({
      transactionId: r.transactionId, kind: 'BET', status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(changed.payload.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('LOSS emite só Processed: o saldo não mudou', async () => {
    const w = await openWallet(orm, '100.00');
    await submit.execute(command(w, uid(), Kind.Loss, '25.00'));
    expect((await outboxFor(w.walletId)).map((x) => x.event_type)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('BET rejeitada emite só Rejected, com failureCode', async () => {
    const w = await openWallet(orm, '100.00');
    await submit.execute(command(w, uid(), Kind.Bet, '500.00'));
    const rows = await outboxFor(w.walletId);
    expect(rows.map((x) => x.event_type)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]!.payload.data).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS', providerAction: 'RETRY_LATER',
    });
  });

  test('reversão sem referência emite PendingReference', async () => {
    const w = await openWallet(orm, '100.00');
    await submit.execute(
      command(w, uid(), Kind.Refund, '25.00', { referenceExternalTransactionId: uid() }),
    );
    expect((await outboxFor(w.walletId)).map((x) => x.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  test('replay não emite eventos de novo', async () => {
    const w = await openWallet(orm, '100.00');
    const cmd = command(w, uid(), Kind.Bet, '25.00');
    await submit.execute(cmd);
    await submit.execute(cmd);
    await submit.execute(cmd);
    expect(await outboxFor(w.walletId)).toHaveLength(2);
  });

  test('a mesma aposta 50 vezes em paralelo: exatamente dois eventos', async () => {
    const w = await openWallet(orm, '100.00');
    const cmd = command(w, uid(), Kind.Bet, '25.00');
    await Promise.all(Array.from({ length: 50 }, () => submit.execute(cmd)));
    expect(await outboxFor(w.walletId)).toHaveLength(2);
  }, 30_000);

  test('os eventos nascem pendentes, prontos para o publisher', async () => {
    const w = await openWallet(orm, '100.00');
    await submit.execute(command(w, uid(), Kind.Bet, '25.00'));
    const pending = await count(
      'select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is null and attempts = 0',
      [w.walletId],
    );
    expect(pending).toBe(2);
  });
});

describe('abertura de wallet', () => {
  test('saldo inicial emite WalletBalanceChanged; saldo zero não emite nada', async () => {
    const open = new OpenWallet(realUow);
    const funded = await open.execute({
      playerId: uid(), initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    const rows = await outboxFor(funded.id);
    expect(rows.map((x) => x.event_type)).toEqual(['WalletBalanceChanged']);
    expect(rows[0]!.payload.data).toMatchObject({
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '50.00', currency: 'BRL' },
      walletVersion: 1,
    });

    const empty = await open.execute({
      playerId: uid(), initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(await outboxFor(empty.id)).toHaveLength(0);
  });
});

/** Executa todo o trabalho e falha no fim: força o rollback depois de tudo gravado. */
class FailAfterWork implements WagerUnitOfWork {
  constructor(private readonly inner: WagerUnitOfWork) {}
  run<T>(work: (repositories: WagerRepositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repositories) => {
      await work(repositories);
      throw new Error('falha simulada depois de gravar tudo');
    });
  }
  isDuplicateKeyError(error: unknown): boolean {
    return this.inner.isDuplicateKeyError(error);
  }
}

describe('atomicidade', () => {
  test('falha no fim: transação, ledger, saldo e outbox somem juntos', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const failing = new SubmitWagerTransaction(new FailAfterWork(realUow));

    expect(failing.execute(command(w, ext, Kind.Bet, '25.00'))).rejects.toThrow('falha simulada');
    await Bun.sleep(100);

    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.version).toBe(1);
    expect(s.debits).toBe(0);
    expect(await outboxFor(w.walletId)).toHaveLength(0);
    expect(
      await count(
        'select count(*)::int as n from wager_transactions where provider_id = ? and external_transaction_id = ?',
        ['prov', ext],
      ),
    ).toBe(0);

    // Nada ficou para trás: a mesma aposta, agora sem falha, processa normalmente.
    const r = await submit.execute(command(w, ext, Kind.Bet, '25.00'));
    expect(String(r.status)).toBe('PROCESSED');
    expect(r.idempotentReplay).toBe(false);
    expect(await outboxFor(w.walletId)).toHaveLength(2);
  });
});
