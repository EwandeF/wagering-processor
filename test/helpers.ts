import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import type { SubmitWagerTransactionCommand } from '../src/application/submit-wager-transaction';
import { LedgerDirection, WagerTransactionKind } from '../src/domain/enums';
import { Money } from '../src/domain/money';
import { WagerTransaction } from '../src/domain/wager-transaction';
import { Wallet } from '../src/domain/wallet';
import { WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import {
  ledgerEntryToRecord,
  wagerTransactionToRecord,
  walletToRecord,
} from '../src/infrastructure/persistence/mappers';
import {
  LedgerEntrySchema,
  WagerTransactionSchema,
  WalletSchema,
} from '../src/infrastructure/persistence/schemas';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const uid = () => uuidv7();

export interface TestWallet {
  walletId: string;
  playerId: string;
}

/** Cria uma wallet com saldo inicial, igual ao POST /wallets fará (OPENING + ledger). */
export async function openWallet(orm: MikroORM, balance: string): Promise<TestWallet> {
  const now = new Date();
  const wallet = Wallet.open({
    id: uid(), playerId: uid(), initialBalance: brl(balance), now,
  });
  const opening = WagerTransaction.createOpening({
    id: uid(), providerId: 'internal', externalTransactionId: `opening:${wallet.id}`,
    idempotencyKey: `opening:${wallet.id}`, payloadHash: 'opening',
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening',
    gameId: 'opening', money: wallet.balance, createdAt: now,
  });
  opening.recordObservedBalance(wallet.balance);
  opening.markProcessed(undefined, now);
  const entry = WalletLedgerEntry.create({
    id: uid(), walletId: wallet.id, transactionId: opening.id,
    direction: LedgerDirection.Credit, money: wallet.balance,
    balanceBefore: brl('0.00'), balanceAfter: wallet.balance, createdAt: now,
  });

  await orm.em.fork().transactional(async (em) => {
    await em.insert(WalletSchema, walletToRecord(wallet));
    await em.insert(WagerTransactionSchema, wagerTransactionToRecord(opening));
    await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
  });
  return { walletId: wallet.id, playerId: wallet.playerId };
}

export function command(
  w: TestWallet,
  externalId: string,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  return {
    idempotencyKey: `prov:${externalId}`,
    providerId: 'prov',
    externalTransactionId: externalId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

interface SummaryRow {
  ledger_balance: string;
  debits: number;
  credits: number;
}

/**
 * Invariante final do case: saldo da wallet == saldo reconstruído pelo ledger.
 * Devolve o resumo para os testes conferirem quantos lançamentos existem.
 */
export async function expectLedgerMatchesWallet(orm: MikroORM, walletId: string) {
  const record = await orm.em.fork().findOneOrFail(WalletSchema, { id: walletId });
  const rows = (await orm.em.getConnection().execute(
    `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)
              ::numeric(19,2)::text as ledger_balance,
            (count(*) filter (where direction = 'DEBIT'))::int as debits,
            (count(*) filter (where direction = 'CREDIT'))::int as credits
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  )) as unknown as SummaryRow[];
  const row = rows[0]!;
  expect(record.balance).toBe(row.ledger_balance);
  expect(Number(record.balance) >= 0).toBe(true);
  return {
    balance: record.balance,
    version: record.version,
    debits: row.debits,
    credits: row.credits,
  };
}
