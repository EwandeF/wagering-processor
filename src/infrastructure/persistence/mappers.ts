import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/enums';
import { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type {
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

const money = (amount: string, currency: string): Money =>
  Money.from({ amount, currency });

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    createdAt: e.createdAt,
  };
}

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

export function wagerTransactionToRecord(t: WagerTransaction): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.toString(),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    observedBalance: t.observedBalance?.toString(),
    referenceAttempts: t.referenceAttempts,
    nextReferenceAttemptAt: t.nextReferenceAttemptAt,
    createdAt: t.createdAt,
    processedAt: t.processedAt,
  };
}

export function wagerTransactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId,
    failureCode: r.failureCode as FailureCode | undefined,
    observedBalance:
      r.observedBalance === undefined ? undefined : money(r.observedBalance, r.currency),
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt,
    processedAt: r.processedAt,
  });
}
