import type { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import type { WagerUnitOfWork } from './application/ports';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
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
  ],
})
export class WageringModule {}
