import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './enums';
import { InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';

// REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND.
const REFUNDABLE: ReadonlySet<Kind> = new Set([Kind.Bet]);
const ROLLBACKABLE: ReadonlySet<Kind> = new Set([Kind.Bet, Kind.Win, Kind.Refund]);

/**
 * Valida uma reversão contra a transação referenciada, nesta ordem:
 * pertencimento, tipo, estado, valor, reversão anterior.
 * Devolve o código de rejeição, ou undefined se a reversão pode ser aplicada.
 *
 * O caller trata antes os casos "referência ausente" e "referência ainda
 * PENDING_REFERENCE", que não são rejeição e sim espera.
 */
export function checkReversal(
  reversal: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (!reversal.requiresReference()) {
    throw new InvalidWagerTransactionError(`${reversal.kind} não é uma reversão`);
  }

  const sameOwner =
    reference.providerId === reversal.providerId &&
    reference.playerId === reversal.playerId &&
    reference.walletId === reversal.walletId &&
    reference.roundId === reversal.roundId &&
    reference.money.currency === reversal.money.currency;
  if (!sameOwner) {
    return FailureCode.ReferenceMismatch;
  }

  const allowed = reversal.kind === Kind.Refund ? REFUNDABLE : ROLLBACKABLE;
  if (!allowed.has(reference.kind)) {
    return FailureCode.InvalidReferenceKind;
  }
  if (reference.status !== Status.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (!reversal.money.equals(reference.money)) {
    return FailureCode.ReversalAmountMismatch;
  }
  if (alreadyReversed) {
    return FailureCode.AlreadyReversed;
  }
  return undefined;
}
