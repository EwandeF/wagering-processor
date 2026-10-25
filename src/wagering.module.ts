import type { MikroORM } from '@mikro-orm/postgresql';
import { Logger, Module } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import type { WagerUnitOfWork } from './application/ports';
import { ReconcileWallet } from './application/reconcile-wallet';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { Metrics } from './infrastructure/observability/metrics';
import { MikroReconciliationReader } from './infrastructure/persistence/mikro-reconciliation-reader';
import { MikroWagerUnitOfWork } from './infrastructure/persistence/mikro-wager-unit-of-work';
import { WagerQueryService } from './infrastructure/persistence/query-service';
import { ORM, WAGER_UNIT_OF_WORK } from './infrastructure/tokens';
import { TransactionsController } from './interfaces/http/transactions.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

@Module({
  controllers: [WalletsController, TransactionsController],
  providers: [
    {
      provide: WAGER_UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroWagerUnitOfWork(orm),
      inject: [ORM],
    },
    {
      provide: OpenWallet,
      useFactory: (uow: WagerUnitOfWork) => new OpenWallet(uow),
      inject: [WAGER_UNIT_OF_WORK],
    },
    {
      provide: SubmitWagerTransaction,
      useFactory: (uow: WagerUnitOfWork) => new SubmitWagerTransaction(uow),
      inject: [WAGER_UNIT_OF_WORK],
    },
    {
      provide: WagerQueryService,
      useFactory: (orm: MikroORM) => new WagerQueryService(orm),
      inject: [ORM],
    },
    {
      provide: ReconcileWallet,
      useFactory: (orm: MikroORM, metrics: Metrics) => {
        const logger = new Logger('Reconciliation');
        return new ReconcileWallet(new MikroReconciliationReader(orm), (result) => {
          metrics.reconciliationChecks.inc();
          if (!result.consistent) {
            metrics.reconciliationDivergences.inc();
            // Só o necessário para diagnosticar: sem os saldos completos nos logs.
            logger.warn({
              event: 'reconciliation_divergence',
              walletId: result.walletId,
              difference: result.difference,
              checkedEntries: result.checkedEntries,
            });
          }
        });
      },
      inject: [ORM, Metrics],
    },
  ],
})
export class WageringModule {}
