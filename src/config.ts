const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um inteiro positivo, mas é "${raw}"`);
  }
  return value;
};

/** Desligue para subir só a API HTTP, sem publisher, consumidor e worker de referências. */
export const workersEnabled = (): boolean => (process.env.WORKERS_ENABLED ?? 'true') !== 'false';

export const outboxPollMs = (): number => positiveInt('OUTBOX_POLL_MS', 500);
export const referencePollMs = (): number => positiveInt('REFERENCE_POLL_MS', 2_000);
export const consumerMaxReceiveCount = (): number => positiveInt('CONSUMER_MAX_RECEIVE_COUNT', 5);
