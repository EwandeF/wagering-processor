import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletNotFoundError } from '../src/application/errors';
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

describe('SubmitWagerTransaction: regras', () => {
  test('BET debita e gera um lançamento', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Bet, '25.00'));
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('75.00');
    expect(r.idempotentReplay).toBe(false);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.version).toBe(2);
  });

  test('WIN credita', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Win, '30.00'));
    expect(r.balance.amount).toBe('130.00');
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).credits).toBe(2);
  });

  test('LOSS é processada sem mover saldo e sem lançamento', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Loss, '25.00'));
    expect(r.status).toBe(Status.Processed);
    expect(r.balance.amount).toBe('100.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(0);
    expect(s.credits).toBe(1); // só a abertura
    expect(s.version).toBe(1); // version só sobe quando o saldo muda
  });

  test('BET sem saldo é REJECTED, persistida e sem lançamento', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Bet, '100.01'));
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(r.balance.amount).toBe('100.00');
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(0);
    expect(s.version).toBe(1);
  });

  test('jogador diferente do dono da wallet é rejeitado', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(command(w, uid(), Kind.Bet, '10.00', { playerId: uid() }));
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
  });

  test('moeda diferente da wallet é rejeitada', async () => {
    const w = await openWallet(orm, '100.00');
    const r = await submit.execute(
      command(w, uid(), Kind.Bet, '10.00', { money: { amount: '10.00', currency: 'USD' } }),
    );
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(r.balance.currency).toBe('BRL');
  });

  test('wallet inexistente', async () => {
    const ghost = { walletId: uid(), playerId: uid() };
    expect(submit.execute(command(ghost, uid(), Kind.Bet, '10.00'))).rejects.toThrow(
      WalletNotFoundError,
    );
  });

  test('payload inválido é recusado antes de tocar no banco', async () => {
    const w = await openWallet(orm, '100.00');
    expect(
      submit.execute(command(w, uid(), Kind.Bet, '10.5')),
    ).rejects.toThrow();
    expect(
      submit.execute(command(w, uid(), Kind.Refund, '10.00')),
    ).rejects.toThrow();
  });
});

describe('SubmitWagerTransaction: idempotência', () => {
  test('replay devolve o resultado original com o saldo observado na época', async () => {
    const w = await openWallet(orm, '100.00');
    const cmd = command(w, uid(), Kind.Bet, '25.00');
    const first = await submit.execute(cmd);
    await submit.execute(command(w, uid(), Kind.Win, '500.00')); // saldo muda depois

    const replay = await submit.execute(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.amount).toBe('75.00'); // não o saldo atual (575.00)
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('575.00');
    expect(s.debits).toBe(1);
  });

  test('replay de uma rejeição continua rejeitado, sem efeito', async () => {
    const w = await openWallet(orm, '100.00');
    const cmd = command(w, uid(), Kind.Bet, '999.00');
    const first = await submit.execute(cmd);
    const replay = await submit.execute(cmd);
    expect(first.status).toBe(Status.Rejected);
    expect(replay.status).toBe(Status.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma idempotency key com payload diferente é conflito', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '25.00'));
    expect(submit.execute(command(w, ext, Kind.Bet, '26.00'))).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('75.00');
  });

  test('mesmo id externo com outra idempotency key é conflito', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '25.00'));
    const other = command(w, ext, Kind.Bet, '25.00', { idempotencyKey: `outra:${ext}` });
    expect(submit.execute(other)).rejects.toThrow(IdempotencyConflictError);
  });

  test('conflito concorrente: mesma key, valores diferentes, nunca dois débitos', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    const outcomes = await Promise.allSettled([
      submit.execute(command(w, ext, Kind.Bet, '10.00')),
      submit.execute(command(w, ext, Kind.Bet, '20.00')),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(1);
  });
});
