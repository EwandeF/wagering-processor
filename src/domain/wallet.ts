import { LedgerDirection } from './enums';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidWalletOperationError,
} from './errors';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('o saldo inicial não pode ser negativo');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência: não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Retira dinheiro. Falha se o saldo não cobre, sem alterar nada. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValid(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientBalanceError(
        `saldo ${this._balance} é menor que o valor ${movement.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.money));
  }

  /** Adiciona dinheiro. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValid(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  // O lançamento é criado ANTES de mexer no estado: se algo falhar, nada muda.
  private apply(
    direction: LedgerDirection,
    movement: WalletMovement,
    newBalance: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: movement.at,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertValid(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('o valor da movimentação deve ser positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet em ${this.currency}, operação em ${money.currency}`,
      );
    }
  }
}
