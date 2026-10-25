import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { WalletNotFoundError } from '../../application/errors';
import { OpenWallet } from '../../application/open-wallet';
import { WagerQueryService } from '../../infrastructure/persistence/query-service';
import { asObject, parseUuidParam, requireMoney, requireUuid } from './request-parsing';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WagerQueryService) private readonly queries: WagerQueryService,
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
}
