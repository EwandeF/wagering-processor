import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { InboxPayloadMismatchError } from '../src/application/errors';
import type { WagerRepositories, WagerUnitOfWork } from '../src/application/ports';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { command, expectLedgerMatchesWallet, openWallet, uid } from './helpers';

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

const CONSUMER = 'wager-transactions';
const inbox = (messageId: string, payloadHash = 'h1', consumerName = CONSUMER) => ({
  consumerName, messageId, payloadHash,
});

async function sql<T>(query: string, params: unknown[]): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as unknown as T[];
}
const inboxRows = (messageId: string) =>
  sql<{ processed: boolean; payload_hash: string; consumer_name: string }>(
    'select processed_at is not null as processed, payload_hash, consumer_name from inbox_messages where message_id = ? order by consumer_name',
    [messageId],
  );
const outboxCount = async (walletId: string) =>
  (await sql<{ n: number }>('select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]))[0]!.n;

describe('inbox: primeira entrega', () => {
  test('processa e registra a mensagem como processada', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = uid();
    const r = await submit.execute(command(w, uid(), Kind.Bet, '25.00', { inbox: inbox(msg) }));
    expect(String(r.status)).toBe('PROCESSED');
    expect(r.duplicateMessage).toBeUndefined();
    expect(await inboxRows(msg)).toEqual([
      { processed: true, payload_hash: 'h1', consumer_name: CONSUMER },
    ]);
  });

  test('rejeição de negócio também é uma mensagem tratada', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = uid();
    const r = await submit.execute(command(w, uid(), Kind.Bet, '999.00', { inbox: inbox(msg) }));
    expect(String(r.status)).toBe('REJECTED');
    expect(await inboxRows(msg)).toHaveLength(1);
  });
});

describe('inbox: redelivery', () => {
  test('a mesma mensagem de novo não repete nenhum efeito', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const msg = uid();
    const cmd = command(w, ext, Kind.Bet, '25.00', { inbox: inbox(msg) });

    const first = await submit.execute(cmd);
    const second = await submit.execute(cmd);

    expect(second.duplicateMessage).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance.amount).toBe('75.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(await inboxRows(msg)).toHaveLength(1);
  });

  test('30 entregas simultâneas da mesma mensagem: um único efeito', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = uid();
    const cmd = command(w, uid(), Kind.Bet, '25.00', { inbox: inbox(msg) });

    const results = await Promise.all(Array.from({ length: 30 }, () => submit.execute(cmd)));

    expect(results.filter((r) => !r.duplicateMessage)).toHaveLength(1);
    expect(results.filter((r) => r.duplicateMessage)).toHaveLength(29);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(await inboxRows(msg)).toHaveLength(1);
  }, 30_000);

  test('mesmo messageId com conteúdo diferente é erro permanente', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = uid();
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '25.00', { inbox: inbox(msg, 'h1') }));
    expect(
      submit.execute(command(w, ext, Kind.Bet, '25.00', { inbox: inbox(msg, 'OUTRO') })),
    ).rejects.toThrow(InboxPayloadMismatchError);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(1);
  });

  test('o mesmo messageId em consumidores diferentes não se confunde', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = uid();
    const cmdA = command(w, uid(), Kind.Bet, '25.00', { inbox: inbox(msg, 'h1', 'consumidor-a') });
    const first = await submit.execute(cmdA);
    const viaB = await submit.execute({ ...cmdA, inbox: inbox(msg, 'h1', 'consumidor-b') });

    expect(viaB.duplicateMessage).toBeUndefined(); // para o consumidor B é a primeira vez
    expect(viaB.idempotentReplay).toBe(true); // mas a idempotência financeira segura o efeito
    expect(viaB.transactionId).toBe(first.transactionId);
    expect((await inboxRows(msg)).map((r) => r.consumer_name)).toEqual(['consumidor-a', 'consumidor-b']);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(1);
  });

  test('a operação chegou antes por HTTP: a fila vira replay e a inbox é registrada', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const viaHttp = await submit.execute(command(w, ext, Kind.Bet, '25.00'));
    const msg = uid();
    const viaQueue = await submit.execute(command(w, ext, Kind.Bet, '25.00', { inbox: inbox(msg) }));

    expect(viaQueue.idempotentReplay).toBe(true);
    expect(viaQueue.transactionId).toBe(viaHttp.transactionId);
    expect(await inboxRows(msg)).toHaveLength(1);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(1);
    expect(await outboxCount(w.walletId)).toBe(2);
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

describe('inbox: atomicidade', () => {
  test('falha no fim desfaz a inbox junto com transação, ledger, saldo e outbox', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const msg = uid();
    const cmd = command(w, ext, Kind.Bet, '25.00', { inbox: inbox(msg) });
    const failing = new SubmitWagerTransaction(new FailAfterWork(realUow));

    expect(failing.execute(cmd)).rejects.toThrow('falha simulada');
    await Bun.sleep(100);

    expect(await inboxRows(msg)).toHaveLength(0);
    expect(await outboxCount(w.walletId)).toBe(0);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.debits).toBe(0);

    // Como a inbox não ficou gravada, a reentrega da mensagem processa normalmente.
    const retry = await submit.execute(cmd);
    expect(String(retry.status)).toBe('PROCESSED');
    expect(retry.duplicateMessage).toBeUndefined();
    expect(await inboxRows(msg)).toHaveLength(1);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(1);
  });
});
