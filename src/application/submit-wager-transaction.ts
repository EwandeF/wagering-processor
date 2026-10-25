import { v7 as uuidv7 } from 'uuid';
import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/enums';
import { InsufficientBalanceError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import type { IntegrationEvent } from '../domain/integration-event';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { checkReversal } from '../domain/reversal-policy';
import { WagerTransaction } from '../domain/wager-transaction';
import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/wager-events';
import type { Wallet, WalletMovement } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from './errors';
import { hashPayload } from './payload-hash';
import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WagerUnitOfWork,
  WalletRepository,
} from './ports';

/** Identifica a mensagem de fila de onde o comando veio (ausente no caso HTTP). */
export interface InboxInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  /** Rastreia a operação nos logs e eventos; gerado se ausente. */
  correlationId?: string;
  /** Quando presente, a mensagem é deduplicada e registrada na inbox, na mesma transação. */
  inbox?: InboxInput;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  /** A inbox já tinha esta mensagem: nada foi reprocessado. */
  duplicateMessage?: boolean;
}

interface Outcome {
  entry?: WalletLedgerEntry;
  rejection?: FailureCode;
  /** Referência ausente ou ainda pendente: grava PENDING_REFERENCE e espera. */
  waiting?: boolean;
  /** Id interno da transação revertida (REFUND e ROLLBACK processados). */
  referenceId?: string;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const money = Money.from(cmd.money);
    const correlationId = cmd.correlationId ?? uuidv7();

    // Só campos de negócio: o header Idempotency-Key e metadados ficam de fora.
    const payloadHash = hashPayload({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    // Um objeto novo por tentativa: o domínio é mutável durante o processamento.
    const build = () =>
      WagerTransaction.create({
        id: uuidv7(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: this.clock(),
      });

    build(); // valida o comando cedo, antes de abrir transação ou pegar lock

    try {
      return await this.attempt(build(), correlationId, cmd.inbox);
    } catch (error) {
      if (this.uow.isDuplicateKeyError(error)) {
        // Colidiu numa chave única: a segunda tentativa enxerga a linha vencedora.
        return this.attempt(build(), correlationId, cmd.inbox);
      }
      throw error;
    }
  }

  private attempt(
    tx: WagerTransaction,
    correlationId: string,
    inboxInput: InboxInput | undefined,
  ): Promise<SubmitWagerTransactionResult> {
    return this.uow.run(async ({ wallets, transactions, ledger, outbox, inbox }) => {
      const wallet = await wallets.lockById(tx.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${tx.walletId} não existe`);
      }

      // Inbox primeiro, com a wallet travada: entregas simultâneas da mesma
      // mensagem são serializadas, e a segunda enxerga a primeira.
      if (inboxInput) {
        const prior = await inbox.find(inboxInput.consumerName, inboxInput.messageId);
        if (prior) {
          if (!prior.matchesPayload(inboxInput.payloadHash)) {
            throw new InboxPayloadMismatchError(
              `a mensagem ${inboxInput.messageId} já foi recebida com outro conteúdo`,
            );
          }
          const original = (
            await transactions.findExisting(tx.providerId, tx.idempotencyKey, tx.externalTransactionId)
          ).find(
            (e) =>
              e.idempotencyKey === tx.idempotencyKey &&
              e.externalTransactionId === tx.externalTransactionId &&
              e.matchesPayload(tx.payloadHash),
          );
          if (!original) {
            throw new Error(`a inbox registra ${inboxInput.messageId}, mas a transação não existe`);
          }
          return { ...this.toResult(original, wallet, true), duplicateMessage: true };
        }
      }

      const result = await this.process(
        tx, wallet, transactions, ledger, wallets, outbox, correlationId,
      );

      if (inboxInput) {
        const at = this.clock();
        const received = InboxMessage.receive({ ...inboxInput, receivedAt: at });
        received.markProcessed(at);
        await inbox.insert(received);
      }
      return result;
    });
  }

  private async process(
    tx: WagerTransaction,
    wallet: Wallet,
    transactions: WagerTransactionRepository,
    ledger: LedgerRepository,
    wallets: WalletRepository,
    outbox: OutboxRepository,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    const existing = await transactions.findExisting(
      tx.providerId,
      tx.idempotencyKey,
      tx.externalTransactionId,
    );
    const replay = existing.find(
      (e) =>
        e.idempotencyKey === tx.idempotencyKey &&
        e.externalTransactionId === tx.externalTransactionId &&
        e.matchesPayload(tx.payloadHash),
    );
    if (replay) {
      // Replay não emite eventos: eles nasceram na primeira execução.
      return this.toResult(replay, wallet, true);
    }
    if (existing.length > 0) {
      throw new IdempotencyConflictError(
        'idempotency key ou id externo já usados com payload diferente',
      );
    }

    const versionBefore = wallet.version;
    const at = this.clock();
    const outcome = await this.decide(tx, wallet, transactions, at);

    tx.recordObservedBalance(wallet.balance);
    if (outcome.waiting) {
      tx.markPendingReference();
    } else if (outcome.rejection) {
      tx.reject(outcome.rejection);
    } else {
      tx.markProcessed(outcome.referenceId, at);
    }

    // Mesma transação SQL: transação, lançamento, saldo e eventos.
    await transactions.insert(tx);
    if (outcome.entry) {
      await ledger.insert(outcome.entry);
      await wallets.save(wallet, versionBefore);
    }
    for (const event of this.eventsFor(tx, wallet, outcome.entry, correlationId, at)) {
      await outbox.enqueue(OutboxMessage.enqueue(event));
    }
    return this.toResult(tx, wallet, false);
  }

  /** Eventos na ordem em que devem ser publicados (os ids uuidv7 mantêm essa ordem). */
  private eventsFor(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    correlationId: string,
    at: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx = (): EventContext => ({
      eventId: uuidv7(),
      correlationId,
      causationId: tx.id,
      occurredAt: at,
    });

    switch (tx.status) {
      case WagerTransactionStatus.Processed: {
        const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, ctx())];
        if (entry) {
          events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
        }
        return events;
      }
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(tx, ctx())];
      case WagerTransactionStatus.PendingReference:
        return [WagerTransactionPendingReference.from(tx, ctx())];
      default:
        throw new Error(`transação ${tx.id} terminou em ${tx.status}, sem evento definido`);
    }
  }

  private async decide(
    tx: WagerTransaction,
    wallet: Wallet,
    transactions: WagerTransactionRepository,
    at: Date,
  ): Promise<Outcome> {
    if (wallet.playerId !== tx.playerId) {
      return { rejection: FailureCode.PlayerWalletMismatch };
    }
    if (wallet.currency !== tx.money.currency) {
      return { rejection: FailureCode.CurrencyMismatch };
    }

    const movement: WalletMovement = {
      money: tx.money,
      transactionId: tx.id,
      entryId: uuidv7(),
      at,
    };

    switch (tx.kind) {
      case WagerTransactionKind.Bet:
        return this.tryMove(() => wallet.debit(movement), FailureCode.InsufficientFunds);
      case WagerTransactionKind.Win:
        return { entry: wallet.credit(movement) };
      case WagerTransactionKind.Loss:
        return {};
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return this.decideReversal(tx, wallet, transactions, movement);
      default:
        throw new Error(`tipo de transação não suportado: ${tx.kind}`);
    }
  }

  private async decideReversal(
    tx: WagerTransaction,
    wallet: Wallet,
    transactions: WagerTransactionRepository,
    movement: WalletMovement,
  ): Promise<Outcome> {
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (!referenceExternalId) {
      throw new Error(`${tx.kind} sem referência: o domínio deveria ter recusado`);
    }

    const reference = await transactions.findByExternalId(tx.providerId, referenceExternalId);
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { waiting: true };
    }

    const alreadyReversed = await transactions.hasProcessedReversal(reference.id);
    const rejection = checkReversal(tx, reference, alreadyReversed);
    if (rejection) {
      return { rejection };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const outcome = this.tryMove(
      () => (direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement)),
      FailureCode.ReversalWouldOverdraw,
    );
    return outcome.rejection ? outcome : { ...outcome, referenceId: reference.id };
  }

  /** Converte "saldo insuficiente" em rejeição de negócio; outros erros sobem. */
  private tryMove(move: () => WalletLedgerEntry, onInsufficient: FailureCode): Outcome {
    try {
      return { entry: move() };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return { rejection: onInsufficient };
      }
      throw error;
    }
  }

  private toResult(
    tx: WagerTransaction,
    wallet: Wallet,
    idempotentReplay: boolean,
  ): SubmitWagerTransactionResult {
    const observed = tx.observedBalance;
    if (!observed) {
      throw new Error(`transação ${tx.id} sem saldo observado`);
    }
    return {
      transactionId: tx.id,
      status: tx.status,
      // A moeda do saldo é sempre a da wallet, mesmo se a operação veio em outra.
      balance: { amount: observed.toString(), currency: wallet.currency },
      failureCode: tx.failureCode,
      idempotentReplay,
    };
  }
}
