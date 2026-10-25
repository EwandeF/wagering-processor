import type { MikroORM } from '@mikro-orm/postgresql';
import type { MoneyProps } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { wagerTransactionFromRecord, walletFromRecord } from './mappers';
import { WagerTransactionSchema, WalletSchema } from './schemas';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** seq do último item da página: é o que vira o cursor da próxima. */
  lastSeq?: string;
  hasMore: boolean;
}

interface LedgerRow {
  seq: string;
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

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

  /** Paginação por seq (ordem de commit na wallet): estável mesmo com escritas concorrentes. */
  async ledgerPage(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = (await this.orm.em.getConnection().execute(
      `select seq::text as seq, id, transaction_id, direction,
              amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after,
              created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?::bigint
        order by seq
        limit ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    )) as unknown as LedgerRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before, currency: r.currency },
        balanceAfter: { amount: r.balance_after, currency: r.currency },
        createdAt: new Date(r.created_at).toISOString(),
      })),
      lastSeq: page.length > 0 ? page[page.length - 1]!.seq : undefined,
      hasMore,
    };
  }
}
