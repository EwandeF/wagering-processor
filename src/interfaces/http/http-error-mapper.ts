import { ConnectionException } from '@mikro-orm/core';
import { HttpException } from '@nestjs/common';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import {
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidWalletOperationError,
} from '../../domain/errors';
import { ForbiddenError, InvalidRequestError, UnauthorizedError } from './http-errors';

export interface MappedHttpError {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}

// Erros de driver/rede/Postgres que indicam "tente de novo", não "bug".
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  '57P01', '57P02', '57P03', // shutdown / crash / cannot connect now
  '53300', '53400', // too many connections / config limit
  '40001', '40P01', // serialization failure / deadlock
  '08000', '08001', '08003', '08006', // connection exceptions
]);

const HTTP_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

const unavailable = (code: string, message: string): MappedHttpError => ({
  status: 503, code, message, retryAfterSeconds: 1,
});

export function toHttpError(error: unknown): MappedHttpError {
  if (error instanceof UnauthorizedError) {
    return {
      status: 401, code: error.code, message: error.message,
      headers: { 'www-authenticate': 'Bearer' },
    };
  }
  if (error instanceof ForbiddenError) {
    return { status: 403, code: error.code, message: error.message };
  }
  if (
    error instanceof InvalidRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidWalletOperationError
  ) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof WalletAlreadyExistsError || error instanceof IdempotencyConflictError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof ConcurrentModificationError) {
    return unavailable(error.code, 'conflito de concorrência; tente novamente');
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: HTTP_CODES[status] ?? `HTTP_${status}`, message: error.message };
  }
  const driverCode = (error as { code?: unknown } | null)?.code;
  if (
    error instanceof ConnectionException ||
    (typeof driverCode === 'string' && TRANSIENT_CODES.has(driverCode))
  ) {
    return unavailable('SERVICE_UNAVAILABLE', 'serviço temporariamente indisponível');
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'erro interno' };
}
