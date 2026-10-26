import { v7 as uuidv7 } from 'uuid';

// Só caracteres seguros: um valor livre poderia forjar linhas nos logs.
const VALID = /^[A-Za-z0-9._:-]{1,100}$/;

/** Usa o X-Correlation-Id do cliente se ele for seguro; senão gera um novo. */
export function resolveCorrelationId(header: string | undefined): string {
  return header !== undefined && VALID.test(header) ? header : uuidv7();
}
