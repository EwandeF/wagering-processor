import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/enums';
import { FailureCode } from '../src/domain/failure-code';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { type TestWallet, command, expectLedgerMatchesWallet, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
});
afterAll(async () => {
  await orm.close(true);
});

async function place(w: TestWallet, kind: Kind, amount: string) {
  const ext = uid();
  const r = await submit.execute(command(w, ext, kind, amount));
  return { ext, r };
}

const reverse = (w: TestWallet, kind: Kind, refExt: string, amount = '25.00', ext = uid()) =>
  submit.execute(command(w, ext, kind, amount, { referenceExternalTransactionId: refExt }));

describe('reversões aplicadas', () => {
  test('REFUND de BET devolve o dinheiro', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const r = await reverse(w, Kind.Refund, bet.ext);
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('100.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.debits).toBe(1);
    expect(s.credits).toBe(2); // abertura + estorno
  });

  test('ROLLBACK de BET credita', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const r = await reverse(w, Kind.Rollback, bet.ext);
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('100.00');
    await expectLedgerMatchesWallet(orm, w.walletId);
  });

  test('ROLLBACK de WIN debita', async () => {
    const w = await openWallet(orm, '100.00');
    const win = await place(w, Kind.Win, '30.00');
    const r = await reverse(w, Kind.Rollback, win.ext, '30.00');
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('100.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
  });

  test('ROLLBACK de REFUND debita de volta', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const refund = await place(w, Kind.Refund, '25.00').catch(() => undefined);
    expect(refund).toBeUndefined(); // sem referência o domínio recusa antes do banco

    const refundExt = uid();
    await reverse(w, Kind.Refund, bet.ext, '25.00', refundExt);
    const r = await reverse(w, Kind.Rollback, refundExt);
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('75.00');
    await expectLedgerMatchesWallet(orm, w.walletId);
  });

  test('o replay de uma reversão devolve o saldo observado na época', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const ext = uid();
    const first = await reverse(w, Kind.Refund, bet.ext, '25.00', ext);
    await submit.execute(command(w, uid(), Kind.Win, '500.00'));
    const replay = await reverse(w, Kind.Refund, bet.ext, '25.00', ext);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.amount).toBe('100.00');
  });
});

describe('reversões rejeitadas', () => {
  test('a mesma BET não é revertida duas vezes pelo mesmo tipo', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    await reverse(w, Kind.Refund, bet.ext);
    const second = await reverse(w, Kind.Refund, bet.ext);
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
  });

  test('REFUND e depois ROLLBACK da mesma BET: o segundo é rejeitado (sem crédito duplicado)', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    await reverse(w, Kind.Refund, bet.ext);
    const rb = await reverse(w, Kind.Rollback, bet.ext);
    expect(rb.status).toBe(Status.Rejected);
    expect(rb.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
  });

  test('REFUND só referencia BET', async () => {
    const w = await openWallet(orm, '100.00');
    const win = await place(w, Kind.Win, '30.00');
    const r = await reverse(w, Kind.Refund, win.ext, '30.00');
    expect(r.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('valor diferente do da referência', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const r = await reverse(w, Kind.Refund, bet.ext, '10.00');
    expect(r.failureCode).toBe(FailureCode.ReversalAmountMismatch);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('75.00');
  });

  test('referência rejeitada não pode ser revertida', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '999.00');
    expect(bet.r.status).toBe(Status.Rejected);
    const r = await reverse(w, Kind.Refund, bet.ext, '999.00');
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('referência de outra wallet ou outro jogador', async () => {
    const a = await openWallet(orm, '100.00');
    const b = await openWallet(orm, '100.00');
    const bet = await place(a, Kind.Bet, '25.00');
    const r = await reverse(b, Kind.Refund, bet.ext);
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await expectLedgerMatchesWallet(orm, a.walletId)).balance).toBe('75.00');
    expect((await expectLedgerMatchesWallet(orm, b.walletId)).balance).toBe('100.00');
  });

  test('reversão que deixaria o saldo negativo tem código próprio', async () => {
    const w = await openWallet(orm, '100.00');
    const win = await place(w, Kind.Win, '50.00'); // 150
    const bet = await place(w, Kind.Bet, '150.00'); // 0
    expect(bet.r.balance.amount).toBe('0.00');

    const r = await reverse(w, Kind.Rollback, win.ext, '50.00');
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(r.failureCode).not.toBe(FailureCode.InsufficientFunds);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('0.00');
  });
});

describe('referência fora de ordem', () => {
  test('reversão antes da referência vira PENDING_REFERENCE, sem mexer em saldo', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const r = await reverse(w, Kind.Refund, `ainda-nao-chegou-${uid()}`, '25.00', ext);
    expect(r.status).toBe(Status.PendingReference);
    expect(r.balance.amount).toBe('100.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.version).toBe(1);
    expect(s.credits).toBe(1); // só a abertura
  });

  test('o replay de uma transação pendente devolve a mesma pendência', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const refExt = uid();
    const first = await reverse(w, Kind.Refund, refExt, '25.00', ext);
    const replay = await reverse(w, Kind.Refund, refExt, '25.00', ext);
    expect(replay.status).toBe(Status.PendingReference);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('reversão de uma referência que também está pendente também espera', async () => {
    const w = await openWallet(orm, '100.00');
    const refundExt = uid();
    await reverse(w, Kind.Refund, uid(), '25.00', refundExt); // pendente
    const rb = await reverse(w, Kind.Rollback, refundExt);
    expect(rb.status).toBe(Status.PendingReference);
  });
});

describe('concorrência nas reversões', () => {
  test('20 REFUNDs concorrentes da mesma BET: exatamente um é aplicado', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reverse(w, Kind.Refund, bet.ext)),
    );
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.failureCode === FailureCode.AlreadyReversed)).toBe(true);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.credits).toBe(2);
  }, 30_000);

  test('REFUND e ROLLBACK da mesma BET ao mesmo tempo: só um vale', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const results = await Promise.all([
      reverse(w, Kind.Refund, bet.ext),
      reverse(w, Kind.Rollback, bet.ext),
    ]);
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
  });

  test('a mesma reversão enviada 30 vezes em paralelo credita uma vez', async () => {
    const w = await openWallet(orm, '100.00');
    const bet = await place(w, Kind.Bet, '25.00');
    const ext = uid();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => reverse(w, Kind.Refund, bet.ext, '25.00', ext)),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.credits).toBe(2);
  }, 30_000);
});
