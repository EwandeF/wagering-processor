export interface ProviderIdentity {
  /** Quem chama: usuário, cliente OAuth ou serviço. */
  subject: string;
  /** Se presente, o chamador só atua em nome deste provedor. Ausente: sem restrição de provedor. */
  providerId?: string;
}

export interface RequestCredentials {
  /** Valor do header Authorization, sem interpretação. */
  authorization?: string;
}

/**
 * Ponto de extensão da autenticação. Uma implementação real validaria o token
 * (assinatura, emissor, audiência e validade) contra um provedor de identidade
 * externo e mapearia uma claim para `providerId`. Devolve undefined se as
 * credenciais faltam ou são inválidas.
 */
export interface ProviderIdentityPort {
  identify(credentials: RequestCredentials): Promise<ProviderIdentity | undefined>;
}
