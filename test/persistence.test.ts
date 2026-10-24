import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../src/domain/enums';
import { Money } from '../src/domain/money';
import { WagerTransaction } from '../src/domain/wager-transaction';
import { Wallet } from '../src/domain/wallet';
import { WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import config from '../src/infrastructure/database/mikro-orm.config';
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletToRecord,
} from '../src/infrastructure/persistence/mappers';
import {
  LedgerEntrySchema,
  WagerTransactionSchema,
  WalletSchema,
} from '../src/infrastructure/persistence/schemas';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(config);
});
afterAll(async () => {
  await orm.close(true);
});

describe('persistência real (Postgres)', () => {
  test('wallet, transação OPENING e lançamento fazem ida e volta', async () => {
    const now = new Date();
    const wallet = Wallet.open({
      id: uuidv7(), playerId: uuidv7(), initialBalance: brl('100.00'), now,
    });
    const tx = WagerTransaction.createOpening({
      id: uuidv7(), providerId: 'internal', externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`, payloadHash: 'h', walletId: wallet.id,
      playerId: wallet.playerId, roundId: 'opening', gameId: 'opening',
      money: brl('100.00'), createdAt: now,
    });
    const entry = WalletLedgerEntry.create({
      id: uuidv7(), walletId: wallet.id, transactionId: tx.id,
      direction: LedgerDirection.Credit, money: brl('100.00'),
      balanceBefore: brl('0.00'), balanceAfter: brl('100.00'), createdAt: now,
    });

    // Tudo na mesma transação SQL, INSERTs na ordem das chaves estrangeiras.
    await orm.em.fork().transactional(async (em) => {
      await em.insert(WalletSchema, walletToRecord(wallet));
      await em.insert(WagerTransactionSchema, wagerTransactionToRecord(tx));
      await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
    });

    const em = orm.em.fork();
    const walletRec = await em.findOneOrFail(WalletSchema, { id: wallet.id });
    expect(typeof walletRec.balance).toBe('string');
    expect(walletFromRecord(walletRec).balance.toString()).toBe('100.00');
    expect(walletFromRecord(walletRec).version).toBe(1);

    const txRec = await em.findOneOrFail(WagerTransactionSchema, { id: tx.id });
    const txBack = wagerTransactionFromRecord(txRec);
    expect(txBack.kind).toBe(WagerTransactionKind.Opening);
    expect(txBack.status).toBe(WagerTransactionStatus.Pending);
    expect(txBack.referenceTransactionId).toBeUndefined();
    expect(txBack.failureCode).toBeUndefined();

    const entryRec = await em.findOneOrFail(LedgerEntrySchema, { id: entry.id });
    const entryBack = ledgerEntryFromRecord(entryRec);
    expect(entryBack.isBalanced()).toBe(true);
    expect(entryBack.balanceAfter.toString()).toBe('100.00');
  });

  test('lock pessimista de linha dentro de transação', async () => {
    const wallet = Wallet.open({ id: uuidv7(), playerId: uuidv7(), initialBalance: brl('10.00') });
    await orm.em.fork().insert(WalletSchema, walletToRecord(wallet));

    const locked = await orm.em.fork().transactional(async (em) => {
      const rec = await em.findOneOrFail(
        WalletSchema, { id: wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      return walletFromRecord(rec);
    });
    expect(locked.balance.toString()).toBe('10.00');
  });

  test('o banco recusa wallet duplicada para o mesmo jogador e moeda', async () => {
    const playerId = uuidv7();
    const a = Wallet.open({ id: uuidv7(), playerId, initialBalance: brl('1.00') });
    const b = Wallet.open({ id: uuidv7(), playerId, initialBalance: brl('1.00') });
    await orm.em.fork().insert(WalletSchema, walletToRecord(a));
    expect(orm.em.fork().insert(WalletSchema, walletToRecord(b))).rejects.toThrow();
  });
});
