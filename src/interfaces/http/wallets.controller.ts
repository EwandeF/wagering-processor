import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { WalletNotFoundError } from '../../application/errors';
import { OpenWallet } from '../../application/open-wallet';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { WagerQueryService } from '../../infrastructure/persistence/query-service';
import { decodeCursor, encodeCursor, parseLimit } from './cursor';
import { asObject, parseUuidParam, requireMoney, requireUuid } from './request-parsing';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WagerQueryService) private readonly queries: WagerQueryService,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const obj = asObject(body);
    return this.openWallet.execute({
      playerId: requireUuid(obj, 'playerId'),
      initialBalance: requireMoney(obj, 'initialBalance'),
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const id = parseUuidParam(walletId, 'walletId');
    const wallet = await this.queries.findWallet(id);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${id} não existe`);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const id = parseUuidParam(walletId, 'walletId');
    // Valida a entrada antes de tocar no banco.
    const size = parseLimit(limit);
    const afterSeq = cursor === undefined ? undefined : decodeCursor(cursor);

    if (!(await this.queries.findWallet(id))) {
      throw new WalletNotFoundError(`wallet ${id} não existe`);
    }
    const page = await this.queries.ledgerPage(id, afterSeq, size);
    return {
      items: page.items,
      nextCursor: page.hasMore && page.lastSeq ? encodeCursor(page.lastSeq) : null,
    };
  }

  /** Só lê e compara: divergência nunca é corrigida em silêncio. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(parseUuidParam(walletId, 'walletId'));
  }
}
