import { WagerTransactionStatus } from './enums';
import type { LedgerDirection } from './enums';
import { InvalidWagerTransactionError } from './errors';
import { FAILURE_GUIDANCE } from './failure-code';
import { IntegrationEvent } from './integration-event';
import type { MoneyProps } from './money';
import type { WagerTransaction } from './wager-transaction';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  /** Saldo da wallet observado no processamento. */
  balance?: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: string;
  providerAction: string;
}

function transactionData(t: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    balance: t.observedBalance?.toJSON(),
  };
}

function assertStatus(t: WagerTransaction, expected: WagerTransactionStatus, event: string): void {
  if (t.status !== expected) {
    throw new InvalidWagerTransactionError(
      `${event} exige transação ${expected}, mas ela está ${t.status}`,
    );
  }
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(t, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: t.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: transactionData(t),
    });
  }
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(t, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    const failureCode = t.failureCode;
    if (!failureCode) {
      throw new InvalidWagerTransactionError('transação rejeitada sem failureCode');
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: t.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: { ...transactionData(t), failureCode, providerAction: FAILURE_GUIDANCE[failureCode] },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

/** Referência ausente: a transação ficou esperando. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(t, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: t.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: transactionData(t),
    });
  }
}
