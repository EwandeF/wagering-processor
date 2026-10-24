import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrentModificationError } from '../../application/errors';
import type { WagerRepositories, WagerUnitOfWork } from '../../application/ports';
import {
  ledgerEntryToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
} from './mappers';
import { LedgerEntrySchema, WagerTransactionSchema, WalletSchema } from './schemas';

export class MikroWagerUnitOfWork implements WagerUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (repositories: WagerRepositories) => Promise<T>): Promise<T> {
    // Um fork por execução: Identity Map e conexão próprios, sem estado compartilhado.
    return this.orm.em.fork().transactional(async (em) =>
      work({
        wallets: {
          lockById: async (id) => {
            const record = await em.findOne(
              WalletSchema,
              { id },
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            );
            return record ? walletFromRecord(record) : undefined;
          },
          save: async (wallet, expectedVersion) => {
            const updated = await em.nativeUpdate(
              WalletSchema,
              { id: wallet.id, version: expectedVersion },
              {
                balance: wallet.balance.toString(),
                version: wallet.version,
                updatedAt: wallet.updatedAt,
              },
            );
            if (updated !== 1) {
              throw new ConcurrentModificationError(
                `wallet ${wallet.id} mudou durante o processamento`,
              );
            }
          },
        },
        transactions: {
          findExisting: async (providerId, idempotencyKey, externalTransactionId) => {
            const records = await em.find(WagerTransactionSchema, {
              providerId,
              $or: [{ idempotencyKey }, { externalTransactionId }],
            });
            return records.map(wagerTransactionFromRecord);
          },
          insert: async (transaction) => {
            await em.insert(WagerTransactionSchema, wagerTransactionToRecord(transaction));
          },
        },
        ledger: {
          insert: async (entry) => {
            await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
          },
        },
      }),
    );
  }

  isDuplicateKeyError(error: unknown): boolean {
    return error instanceof UniqueConstraintViolationException;
  }
}
