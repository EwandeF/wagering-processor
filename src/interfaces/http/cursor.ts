import { InvalidRequestError } from './http-errors';

/** Cursor opaco: base64url de { v: 1, s: <seq> }. O cliente só devolve o que recebeu. */
export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: seq })).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const invalid = () => new InvalidRequestError('cursor inválido');
  if (cursor.length === 0 || cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const obj = parsed as { v?: unknown; s?: unknown } | null;
  if (obj === null || typeof obj !== 'object' || obj.v !== 1) throw invalid();
  // seq é bigint: trafega como texto, sem passar por number.
  if (typeof obj.s !== 'string' || !/^[1-9]\d{0,17}$/.test(obj.s)) throw invalid();
  return obj.s;
}

export function parseLimit(raw: string | undefined, fallback = 50, max = 200): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,4}$/.test(raw)) {
    throw new InvalidRequestError(`limit deve ser um inteiro de 1 a ${max}`);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > max) {
    throw new InvalidRequestError(`limit deve ser um inteiro de 1 a ${max}`);
  }
  return limit;
}
