import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { type TestWallet, command, openWallet, uid } from './helpers';

let orm: MikroORM;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  submit = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
});
afterAll(async () => {
  await orm.close(true);
});

const SENTINEL = 'SQL_NAO_FOI_RECUSADO';

/**
 * Roda o comando dentro de um bloco que SEMPRE desfaz. Se o banco recusar, o erro dele
 * sobe. Se NÃO recusar, o bloco falha com o SENTINEL e nada fica gravado: um TRUNCATE
 * sem gatilho não apagaria o ledger.
 */
const run = (sql: string) =>
  orm.em.getConnection().execute(`do $$ begin ${sql}; raise exception '${SENTINEL}'; end $$`);

const rejected = async (sql: string, expected: string) => {
  await expect(run(sql)).rejects.toThrow(expected);
};
/** Controle: o mesmo SQL, válido, só falha pela marca do SENTINEL. */
const accepted = async (sql: string) => {
  await expect(run(sql)).rejects.toThrow(SENTINEL);
};

function txInsert(w: TestWallet, cols: Record<string, string> = {}): string {
  const all: Record<string, string> = {
    id: `'${uid()}'`,
    provider_id: "'p'",
    external_transaction_id: `'${uid()}'`,
    idempotency_key: `'${uid()}'`,
    payload_hash: "'h'",
    wallet_id: `'${w.walletId}'`,
    player_id: `'${w.playerId}'`,
    round_id: "'r'",
    game_id: "'g'",
    kind: "'BET'",
    amount: '10.00',
    currency: "'BRL'",
    ...cols,
  };
  return `insert into wager_transactions (${Object.keys(all).join(', ')}) values (${Object.values(all).join(', ')})`;
}

function ledgerInsert(w: TestWallet, txId: string, cols: Record<string, string> = {}): string {
  const all: Record<string, string> = {
    id: `'${uid()}'`,
    wallet_id: `'${w.walletId}'`,
    transaction_id: `'${txId}'`,
    direction: "'CREDIT'",
    amount: '10.00',
    currency: "'BRL'",
    balance_before: '100.00',
    balance_after: '110.00',
    ...cols,
  };
  return `insert into wallet_ledger_entries (${Object.keys(all).join(', ')}) values (${Object.values(all).join(', ')})`;
}

const walletInsert = (cols: Record<string, string> = {}) => {
  const all: Record<string, string> = {
    id: `'${uid()}'`,
    player_id: `'${uid()}'`,
    currency: "'BRL'",
    balance: '1.00',
    ...cols,
  };
  return `insert into wallets (${Object.keys(all).join(', ')}) values (${Object.values(all).join(', ')})`;
};

describe('wallets', () => {
  test('controle: uma wallet válida seria aceita', async () => {
    await accepted(walletInsert());
  });

  test('saldo negativo é recusado, no INSERT e no UPDATE', async () => {
    await rejected(walletInsert({ balance: '-1.00' }), 'wallets_balance_non_negative');
    const w = await openWallet(orm, '10.00');
    await rejected(`update wallets set balance = -0.01 where id = '${w.walletId}'`, 'wallets_balance_non_negative');
  });

  test('moeda mal formada e version zero são recusadas', async () => {
    await rejected(walletInsert({ currency: "'brl'" }), 'wallets_currency_format');
    await rejected(walletInsert({ version: '0' }), 'wallets_version_positive');
  });

  test('uma wallet por jogador e moeda: outra moeda passa, a mesma não', async () => {
    const w = await openWallet(orm, '10.00');
    await rejected(walletInsert({ player_id: `'${w.playerId}'` }), 'wallets_player_currency_unique');
    await accepted(walletInsert({ player_id: `'${w.playerId}'`, currency: "'USD'" }));
  });
});

describe('wager_transactions', () => {
  test('controle: uma transação válida seria aceita', async () => {
    const w = await openWallet(orm, '10.00');
    await accepted(txInsert(w));
  });

  test('wallet inexistente é recusada pela chave estrangeira', async () => {
    const w = await openWallet(orm, '10.00');
    await rejected(txInsert(w, { wallet_id: `'${uid()}'` }), 'wager_transactions_wallet_id_fkey');
  });

  test('idempotency key e id externo são únicos por provedor', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await submit.execute(command(w, ext, Kind.Bet, '10.00')); // provedor 'prov', chave `prov:${ext}`
    await rejected(
      txInsert(w, { provider_id: "'prov'", idempotency_key: `'prov:${ext}'` }),
      'wager_tx_idempotency_unique',
    );
    await rejected(
      txInsert(w, { provider_id: "'prov'", external_transaction_id: `'${ext}'` }),
      'wager_tx_external_unique',
    );
    // Outro provedor pode usar os mesmos valores.
    await accepted(
      txInsert(w, { provider_id: "'outro'", idempotency_key: `'prov:${ext}'`, external_transaction_id: `'${ext}'` }),
    );
  });

  test('tipo, status e valor inválidos são recusados', async () => {
    const w = await openWallet(orm, '10.00');
    await rejected(txInsert(w, { kind: "'DEPOSIT'" }), 'wager_tx_kind_valid');
    await rejected(txInsert(w, { status: "'DONE'", observed_balance: '1.00' }), 'wager_tx_status_valid');
    await rejected(txInsert(w, { amount: '-1.00' }), 'wager_tx_amount_non_negative');
  });

  test('REFUND exige referência e BET não pode ter', async () => {
    const w = await openWallet(orm, '10.00');
    await rejected(txInsert(w, { kind: "'REFUND'" }), 'wager_tx_reference_required');
    await rejected(txInsert(w, { reference_external_transaction_id: "'x'" }), 'wager_tx_reference_required');
    await accepted(txInsert(w, { kind: "'REFUND'", reference_external_transaction_id: "'x'" }));
  });

  test('o estado da transação tem de ser consistente com seus campos', async () => {
    const w = await openWallet(orm, '10.00');
    // REJECTED sem failureCode
    await rejected(txInsert(w, { status: "'REJECTED'", observed_balance: '1.00' }), 'wager_tx_failure_code_consistent');
    // PROCESSED sem a hora do processamento
    await rejected(txInsert(w, { status: "'PROCESSED'", observed_balance: '1.00' }), 'wager_tx_processed_at_consistent');
    // qualquer estado fora de PENDING sem o saldo observado
    await rejected(
      txInsert(w, { status: "'REJECTED'", failure_code: "'X'" }),
      'wager_tx_observed_balance_consistent',
    );
    // PENDING_REFERENCE sem a hora da próxima checagem
    await rejected(
      txInsert(w, {
        kind: "'REFUND'", reference_external_transaction_id: "'x'",
        status: "'PENDING_REFERENCE'", observed_balance: '1.00',
      }),
      'wager_tx_next_reference_consistent',
    );
    // Controle: o mesmo PROCESSED, agora completo, seria aceito.
    await accepted(txInsert(w, { status: "'PROCESSED'", observed_balance: '1.00', processed_at: 'now()' }));
  });

  test('cada transação só pode ser revertida uma vez; uma rejeição não ocupa a vaga', async () => {
    const w = await openWallet(orm, '100.00');
    const betExt = uid();
    const bet = await submit.execute(command(w, betExt, Kind.Bet, '10.00'));
    const refund = await submit.execute(
      command(w, uid(), Kind.Refund, '10.00', { referenceExternalTransactionId: betExt }),
    );
    expect(String(refund.status)).toBe('PROCESSED');

    const reversal = (extra: Record<string, string>) =>
      txInsert(w, {
        kind: "'ROLLBACK'",
        reference_external_transaction_id: `'${betExt}'`,
        reference_transaction_id: `'${bet.transactionId}'`,
        observed_balance: '1.00',
        ...extra,
      });
    await rejected(reversal({ status: "'PROCESSED'", processed_at: 'now()' }), 'wager_tx_one_reversal_per_reference');
    await accepted(reversal({ status: "'REJECTED'", failure_code: "'ALREADY_REVERSED'" }));
  });
});

describe('ledger', () => {
  test('conta que não fecha, valor zero e saldo negativo são recusados', async () => {
    const w = await openWallet(orm, '100.00');
    const loss = await submit.execute(command(w, uid(), Kind.Loss, '1.00')); // processada, sem lançamento
    await accepted(ledgerInsert(w, loss.transactionId)); // controle
    await rejected(ledgerInsert(w, loss.transactionId, { balance_after: '999.00' }), 'ledger_is_balanced');
    await rejected(ledgerInsert(w, loss.transactionId, { amount: '0.00', balance_after: '100.00' }), 'ledger_amount_positive');
    await rejected(
      ledgerInsert(w, loss.transactionId, { direction: "'DEBIT'", balance_before: '5.00', balance_after: '-5.00' }),
      'ledger_balances_non_negative',
    );
  });

  test('uma transação gera no máximo um lançamento por wallet', async () => {
    const w = await openWallet(orm, '100.00');
    const win = await submit.execute(command(w, uid(), Kind.Win, '25.00')); // lançamento 100 -> 125
    await rejected(
      ledgerInsert(w, win.transactionId, { amount: '25.00', balance_before: '125.00', balance_after: '150.00' }),
      'ledger_one_entry_per_wallet_tx',
    );
  });

  test('UPDATE, DELETE e TRUNCATE do ledger são recusados', async () => {
    const w = await openWallet(orm, '100.00'); // já tem o lançamento de abertura
    await rejected(`update wallet_ledger_entries set amount = 1.00 where wallet_id = '${w.walletId}'`, 'imutável');
    await rejected(`delete from wallet_ledger_entries where wallet_id = '${w.walletId}'`, 'imutável');
    await rejected('truncate wallet_ledger_entries', 'imutável');
  });
});

describe('inbox e outbox', () => {
  test('a inbox é única por consumidor e mensagem', async () => {
    const m = uid();
    const insert = (consumer: string) =>
      `insert into inbox_messages (consumer_name, message_id, payload_hash) values ('${consumer}', '${m}', 'h')`;
    await rejected(`${insert('c')}; ${insert('c')}`, 'inbox_messages_pkey');
    await accepted(`${insert('c1')}; ${insert('c2')}`); // consumidores diferentes não se confundem
  });

  test('a outbox recusa tentativas negativas e payload que não é objeto', async () => {
    const insert = (payload: string, attempts: string) =>
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values ('${uid()}', '${uid()}', 'X', '${payload}'::jsonb, now(), ${attempts})`;
    await accepted(insert('{}', '0'));
    await rejected(insert('{}', '-1'), 'outbox_attempts_non_negative');
    await rejected(insert('[]', '0'), 'outbox_payload_is_object');
  });
});
