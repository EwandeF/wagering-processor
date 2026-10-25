import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** SELECT ... FOR UPDATE: trava a linha até o fim da transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Grava saldo e version; falha se a version no banco não for a esperada. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
  insert(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  /** Transações do provedor com a mesma idempotency key OU o mesmo id externo. */
  findExisting(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  /** Resolve a referência de uma reversão: (providerId, id externo no provedor). */
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND ou ROLLBACK PROCESSED revertendo esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Atualiza o que muda depois da criação: status, falha, saldo observado, agendamento. */
  update(transaction: WagerTransaction): Promise<void>;
  insert(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

/** Eventos gravados na mesma transação SQL da mudança financeira. */
export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
}

/** Mensagens de fila já tratadas, por (consumerName, messageId). */
export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
}

export interface WagerRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/** Tudo que roda em `run` participa da mesma transação SQL. */
export interface WagerUnitOfWork {
  run<T>(work: (repositories: WagerRepositories) => Promise<T>): Promise<T>;
  isDuplicateKeyError(error: unknown): boolean;
}
