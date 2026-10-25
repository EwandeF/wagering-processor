import { validate as isUuid } from 'uuid';
import type { MoneyProps } from '../../domain/money';
import { InvalidRequestError } from './http-errors';

export function asObject(value: unknown, what = 'corpo da requisição'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`${what} deve ser um objeto JSON`);
  }
  return value as Record<string, unknown>;
}

export function requireText(obj: Record<string, unknown>, key: string, max = 200): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new InvalidRequestError(`${key} deve ser um texto de 1 a ${max} caracteres`);
  }
  return value;
}

export function optionalText(
  obj: Record<string, unknown>,
  key: string,
  max = 200,
): string | undefined {
  return obj[key] === undefined ? undefined : requireText(obj, key, max);
}

export function requireUuid(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new InvalidRequestError(`${key} deve ser um UUID`);
  }
  return value.toLowerCase();
}

export function parseUuidParam(value: string, name: string): string {
  if (!isUuid(value)) {
    throw new InvalidRequestError(`${name} deve ser um UUID`);
  }
  return value.toLowerCase();
}

/** O formato do valor (2 casas, sem sinal) é validado pelo Money.from. */
export function requireMoney(obj: Record<string, unknown>, key: string): MoneyProps {
  const money = asObject(obj[key], key);
  return { amount: money.amount as string, currency: money.currency as string };
}
