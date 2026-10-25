export interface PendingReferencePolicy {
  /** Quantas vezes o worker procura a referência antes de desistir. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * 12 checagens: 5s, 10s, 20s, 40s, 80s, 160s, 320s e depois 10 minutos fixos.
 * A última checagem acontece cerca de 1 hora depois da chegada da reversão.
 */
export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxAttempts: 12,
  baseDelayMs: 5_000,
  maxDelayMs: 600_000,
};

/** Espera até a próxima checagem, dado quantas checagens já foram feitas. */
export function referenceDelayMs(policy: PendingReferencePolicy, attemptsDone: number): number {
  return Math.min(policy.baseDelayMs * 2 ** attemptsDone, policy.maxDelayMs);
}

export function isReferenceExhausted(policy: PendingReferencePolicy, attemptsDone: number): boolean {
  return attemptsDone >= policy.maxAttempts;
}

/** Tempo entre a chegada da reversão e a última checagem. */
export function referenceWindowMs(policy: PendingReferencePolicy): number {
  let total = 0;
  for (let done = 0; done < policy.maxAttempts; done++) {
    total += referenceDelayMs(policy, done);
  }
  return total;
}
