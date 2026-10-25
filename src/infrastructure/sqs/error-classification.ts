import { IdempotencyConflictError, InboxPayloadMismatchError, WalletNotFoundError } from '../../application/errors';
import {
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidWalletOperationError,
} from '../../domain/errors';
import { InvalidRequestError } from '../../interfaces/http/http-errors';
import { MalformedMessageError } from './wager-message';

export type ErrorKind = 'business-terminal' | 'permanent' | 'transient';

/**
 * - business-terminal: não há como ter sucesso, mas não é falha da mensagem (ack).
 * - permanent: reenviar não resolve (DLQ imediata).
 * - transient: tudo o mais, inclusive erros inesperados (retry com limite).
 */
export function classifyError(error: unknown): ErrorKind {
  if (error instanceof IdempotencyConflictError) {
    return 'business-terminal';
  }
  if (
    error instanceof MalformedMessageError ||
    error instanceof InvalidRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidWalletOperationError ||
    error instanceof WalletNotFoundError ||
    error instanceof InboxPayloadMismatchError
  ) {
    return 'permanent';
  }
  return 'transient';
}

export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}
