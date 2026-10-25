import { Counter, Registry } from 'prom-client';

/** Registro próprio por aplicação: sem estado global compartilhado entre instâncias. */
export class Metrics {
  readonly registry = new Registry();

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
}
