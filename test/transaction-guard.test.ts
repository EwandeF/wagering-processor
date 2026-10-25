import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { command, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
});
afterAll(async () => {
  await orm.close(true);
});

const exec = (query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params);

async function rowOf(ext: string) {
  const rows = (await exec(
    `select id, status, failure_code, reference_attempts
       from wager_transactions where provider_id = 'prov' and external_transaction_id = ?`,
    [ext],
  )) as unknown as { id: string; status: string; failure_code: string | null; reference_attempts: number }[];
  return rows[0]!;
}

describe('guarda de imutabilidade da wager_transactions', () => {
  test('transação PROCESSED não muda mais', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '25.00'));
    const { id } = await rowOf(ext);

    await expect(
      exec("update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?", [id]),
    ).rejects.toThrow('não muda mais');
    expect((await rowOf(ext)).status).toBe('PROCESSED');
  });

  test('transação REJECTED não muda mais, nem o código da falha', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '999.00'));
    const { id } = await rowOf(ext);

    await expect(
      exec("update wager_transactions set failure_code = 'ALREADY_REVERSED' where id = ?", [id]),
    ).rejects.toThrow('não muda mais');
    expect((await rowOf(ext)).failure_code).toBe('INSUFFICIENT_FUNDS');
  });

  test('DELETE é recusado, até de transação pendente', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(
      command(w, ext, Kind.Refund, '25.00', { referenceExternalTransactionId: uid() }),
    );
    const { id } = await rowOf(ext);
    await expect(exec('delete from wager_transactions where id = ?', [id])).rejects.toThrow('auditável');
    expect((await rowOf(ext)).status).toBe('PENDING_REFERENCE');
  });

  test('os campos de identidade são imutáveis mesmo em transação pendente', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(
      command(w, ext, Kind.Refund, '25.00', { referenceExternalTransactionId: uid() }),
    );
    const { id } = await rowOf(ext);

    await expect(
      exec('update wager_transactions set amount = 99.00 where id = ?', [id]),
    ).rejects.toThrow('imutáveis');
    await expect(
      exec("update wager_transactions set round_id = 'outra' where id = ?", [id]),
    ).rejects.toThrow('imutáveis');
  });

  test('uma transação nunca volta para PENDING', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(
      command(w, ext, Kind.Refund, '25.00', { referenceExternalTransactionId: uid() }),
    );
    const { id } = await rowOf(ext);
    await expect(
      exec("update wager_transactions set status = 'PENDING', next_reference_attempt_at = null where id = ?", [id]),
    ).rejects.toThrow('voltar');
  });

  test('o que o worker precisa continua permitido: reagendar a checagem', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(
      command(w, ext, Kind.Refund, '25.00', { referenceExternalTransactionId: uid() }),
    );
    const { id } = await rowOf(ext);
    await exec(
      `update wager_transactions
          set reference_attempts = reference_attempts + 1,
              next_reference_attempt_at = next_reference_attempt_at + interval '1 minute'
        where id = ?`,
      [id],
    );
    expect(Number((await rowOf(ext)).reference_attempts)).toBe(1);
  });
});
