import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/enums';
import { FailureCode } from '../src/domain/failure-code';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { command, expectLedgerMatchesWallet, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
});
afterAll(async () => {
  await orm.close(true);
});

describe('concorrência real no Postgres', () => {
  test('cenário obrigatório: saldo 100, duas apostas de 80 em paralelo', async () => {
    const w = await openWallet(orm, '100.00');
    const [a, b] = await Promise.all([
      submit.execute(command(w, uid(), Kind.Bet, '80.00')),
      submit.execute(command(w, uid(), Kind.Bet, '80.00')),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);

    const summary = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(summary.balance).toBe('20.00');
    expect(summary.debits).toBe(1);
    expect(summary.version).toBe(2);
  });

  test('o cenário obrigatório repetido em 15 wallets ao mesmo tempo', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => openWallet(orm, '100.00')));
    const results = await Promise.all(
      wallets.flatMap((w) => [
        submit.execute(command(w, uid(), Kind.Bet, '80.00')),
        submit.execute(command(w, uid(), Kind.Bet, '80.00')),
      ]),
    );
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(15);
    expect(results.filter((r) => r.status === Status.Rejected)).toHaveLength(15);
    for (const w of wallets) {
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s.balance).toBe('20.00');
      expect(s.debits).toBe(1);
    }
  }, 30_000);

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await openWallet(orm, '100.00');
    const cmd = command(w, uid(), Kind.Bet, '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(cmd)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    for (const r of results) {
      expect(r.status).toBe(Status.Processed);
      expect(r.balance.amount).toBe('75.00');
    }
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('75.00');
    expect(s.debits).toBe(1);
  }, 30_000);

  test('wallets distintas processadas em paralelo não se atrapalham', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => openWallet(orm, '100.00')));
    const results = await Promise.all(
      wallets.map((w) => submit.execute(command(w, uid(), Kind.Bet, '10.00'))),
    );
    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    for (const w of wallets) {
      expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('90.00');
    }
  }, 30_000);

  test('wallet quente: 150 apostas de 10 contra saldo 1000, o saldo nunca passa de zero', async () => {
    const w = await openWallet(orm, '1000.00');
    const results = await Promise.all(
      Array.from({ length: 150 }, () => submit.execute(command(w, uid(), Kind.Bet, '10.00'))),
    );
    const processed = results.filter((r) => r.status === Status.Processed);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(processed).toHaveLength(100);
    expect(rejected).toHaveLength(50);
    expect(rejected.every((r) => r.failureCode === FailureCode.InsufficientFunds)).toBe(true);

    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('0.00');
    expect(s.debits).toBe(100);
  }, 60_000);

  test('mistura concorrente de apostas e prêmios fecha com o ledger', async () => {
    const w = await openWallet(orm, '500.00');
    const ops = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? submit.execute(command(w, uid(), Kind.Bet, '20.00'))
        : submit.execute(command(w, uid(), Kind.Win, '5.00')),
    );
    await Promise.all(ops);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    // 30 apostas de 20 (-600) e 30 prêmios de 5 (+150) sobre 500: nem todas as apostas cabem,
    // então o resultado exato depende da ordem, mas o invariante vale sempre.
    expect(Number(s.balance)).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
