import { DomainError } from '../../domain/errors';

/** Requisição malformada na borda HTTP (campo ausente, tipo errado, id inválido). */
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST';
}
