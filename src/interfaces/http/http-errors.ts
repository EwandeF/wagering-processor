import { DomainError } from '../../domain/errors';

/** Requisição malformada na borda HTTP (campo ausente, tipo errado, id inválido). */
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST';
}

/** Credenciais ausentes ou inválidas. */
export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
}

/** Identidade válida, mas sem permissão para este provedor. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}
