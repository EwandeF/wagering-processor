import type { ProviderIdentity, ProviderIdentityPort } from '../../application/identity';

/**
 * Implementação padrão: NÃO autentica. Toda chamada é aceita, sem restrição de provedor.
 * Está aqui para tornar o ponto de extensão explícito; ver ARCHITECTURE.md, seção de autenticação.
 */
export class AnonymousIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity> {
    return { subject: 'anonymous' };
  }
}
