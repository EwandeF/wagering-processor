import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface OutboxProbeResult {
  pending: number;
  lagSeconds: number;
}

/** Registro próprio por aplicação: sem estado global compartilhado entre instâncias. */
export class Metrics {
  readonly registry = new Registry();
  private outboxProbe?: () => Promise<OutboxProbeResult>;

  readonly reconciliationChecks = new Counter({
    name: 'wager_reconciliation_checks_total',
    help: 'Reconciliações de wallet executadas',
    registers: [this.registry],
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wager_reconciliation_divergences_total',
    help: 'Reconciliações que encontraram divergência entre o saldo e o ledger',
    registers: [this.registry],
  });

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações por estado ao chegar (PROCESSED, REJECTED ou PENDING_REFERENCE) e tipo',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Pedidos repetidos detectados, por origem (idempotency ou inbox)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  readonly processingSeconds = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de uma transação, do começo ao commit',
    labelNames: ['status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly walletLockWaitSeconds = new Histogram({
    name: 'wager_wallet_lock_wait_seconds',
    help: 'Tempo esperando o lock de linha da wallet',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de concorrência, por tipo (duplicate_key_retry ou version_conflict)',
    labelNames: ['type'],
    registers: [this.registry],
  });

  readonly consumerMessages = new Counter({
    name: 'wager_consumer_messages_total',
    help: 'Mensagens da fila de entrada, por resultado',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly consumerRetries = new Counter({
    name: 'wager_consumer_retries_total',
    help: 'Mensagens devolvidas à fila para nova tentativa, por erro transitório',
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ, por motivo (permanent ou max-attempts)',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'wager_outbox_published_total',
    help: 'Eventos da outbox publicados no SQS',
    registers: [this.registry],
  });
  readonly outboxPublishFailures = new Counter({
    name: 'wager_outbox_publish_failures_total',
    help: 'Falhas ao publicar um evento da outbox (ele é reagendado com backoff)',
    registers: [this.registry],
  });
  readonly pendingReference = new Counter({
    name: 'wager_pending_reference_total',
    help: 'Resultados do worker de referências pendentes, por desfecho',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  constructor() {
    const metrics = this;
    // Lidos do banco na hora do scrape. Se o banco falhar, o último valor é mantido.
    const pending: Gauge = new Gauge({
      name: 'wager_outbox_pending',
      help: 'Eventos na outbox ainda não publicados',
      registers: [this.registry],
      async collect() {
        try {
          const probe = await metrics.outboxProbe?.();
          if (probe) pending.set(probe.pending);
        } catch {
          // mantém o último valor
        }
      },
    });
    const lag: Gauge = new Gauge({
      name: 'wager_outbox_lag_seconds',
      help: 'Idade, em segundos, do evento não publicado mais antigo (0 se não há pendentes)',
      registers: [this.registry],
      async collect() {
        try {
          const probe = await metrics.outboxProbe?.();
          if (probe) lag.set(probe.lagSeconds);
        } catch {
          // mantém o último valor
        }
      },
    });
  }

  bindOutboxProbe(probe: () => Promise<OutboxProbeResult>): void {
    this.outboxProbe = probe;
  }
}
