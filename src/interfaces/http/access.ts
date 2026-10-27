import type { ProviderIdentity } from '../../application/identity';
import { ForbiddenError } from './http-errors';

export interface AuthenticatedRequest {
  identity?: ProviderIdentity;
}

/** Uma identidade restrita a um provedor só atua em nome dele. */
export function assertProviderAccess(identity: ProviderIdentity | undefined, providerId: string): void {
  if (identity?.providerId !== undefined && identity.providerId !== providerId) {
    throw new ForbiddenError('esta identidade não pode atuar em nome deste provedor');
  }
}

/** Dono da transação diferente do provedor da identidade: tratar como inexistente. */
export function ownsTransaction(identity: ProviderIdentity | undefined, providerId: string): boolean {
  return identity?.providerId === undefined || identity.providerId === providerId;
}
