import { createHash } from 'node:crypto';

/** JSON canônico: chaves ordenadas, sem espaços, undefined descartado. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 (hex) do JSON canônico dos campos de negócio. */
export function hashPayload(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
