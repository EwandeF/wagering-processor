import type { MikroORM } from '@mikro-orm/postgresql';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { wagerTransactionFromRecord, walletFromRecord } from './mappers';
import { WagerTransactionSchema, WalletSchema } from './schemas';

/** Lado de leitura: consultas sem regra de negócio, sem lock. */
export class WagerQueryService {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(id: string): Promise<Wallet | undefined> {
    const record = await this.orm.em.fork().findOne(WalletSchema, { id });
    return record ? walletFromRecord(record) : undefined;
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionSchema, { id });
    return record ? wagerTransactionFromRecord(record) : undefined;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em
      .fork()
      .findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? wagerTransactionFromRecord(record) : undefined;
  }
}
