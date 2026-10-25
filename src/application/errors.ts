import { DomainError } from '../domain/errors';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** Mesma idempotency key (ou mesmo id externo) com payload diferente. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** O UPDATE guardado por version não encontrou a versão esperada. */
export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
}
