import { v7 as uuidv7 } from 'uuid';
import { Money, type MoneyProps } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { LedgerDirection } from '../domain/enums';
import { WalletAlreadyExistsError } from './errors';
import { hashPayload } from './payload-hash';
import type { WagerUnitOfWork } from './ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWallet {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<OpenWalletResult> {
    const initial = Money.from(cmd.initialBalance);
    const now = this.clock();
    const wallet = Wallet.open({
      id: uuidv7(),
      playerId: cmd.playerId,
      initialBalance: initial,
      now,
    });

    try {
      await this.uow.run(async ({ wallets, transactions, ledger }) => {
        await wallets.insert(wallet);

        // Saldo inicial > 0: crédito interno OPENING + lançamento, na mesma transação SQL.
        if (initial.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: uuidv7(),
            providerId: 'internal',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: hashPayload({
              kind: 'OPENING',
              walletId: wallet.id,
              money: initial.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            money: initial,
            createdAt: now,
          });
          opening.recordObservedBalance(wallet.balance);
          opening.markProcessed(undefined, now);
          await transactions.insert(opening);
          await ledger.insert(
            WalletLedgerEntry.create({
              id: uuidv7(),
              walletId: wallet.id,
              transactionId: opening.id,
              direction: LedgerDirection.Credit,
              money: initial,
              balanceBefore: Money.zero(initial.currency),
              balanceAfter: initial,
              createdAt: now,
            }),
          );
        }
      });
    } catch (error) {
      if (this.uow.isDuplicateKeyError(error)) {
        throw new WalletAlreadyExistsError(
          `o jogador ${cmd.playerId} já tem wallet em ${initial.currency}`,
        );
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
