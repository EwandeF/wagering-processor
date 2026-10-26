export interface TransactionRecorded {
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  status: string;
  failureCode?: string;
  correlationId: string;
  durationMs: number;
}

export interface DuplicateDetected {
  source: 'idempotency' | 'inbox';
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  correlationId: string;
}

/** O que o caso de uso conta e registra. Quem traduz em métrica e log é a infraestrutura. */
export interface WagerObserver {
  /** Uma transação nova chegou a um estado (processada, rejeitada ou à espera da referência). */
  transactionRecorded(event: TransactionRecorded): void;
  /** O mesmo pedido voltou e devolveu o resultado original, sem novo efeito. */
  duplicateDetected(event: DuplicateDetected): void;
  /** Quanto o caso de uso esperou pelo lock da wallet. */
  walletLockWaited(milliseconds: number): void;
  lockConflict(type: 'duplicate_key_retry' | 'version_conflict'): void;
}

export const NOOP_OBSERVER: WagerObserver = {
  transactionRecorded: () => {},
  duplicateDetected: () => {},
  walletLockWaited: () => {},
  lockConflict: () => {},
};
