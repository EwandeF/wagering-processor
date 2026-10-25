import { Money, type MoneyProps } from '../domain/money';
import { WalletNotFoundError } from './errors';

export interface ReconciliationSnapshot {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  checkedEntries: number;
}

export interface ReconciliationReader {
  /** Saldo guardado e soma do ledger lidos do mesmo snapshot. */
  read(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Valor com sinal: um ledger corrompido pode somar negativo, e isso tem de aparecer
 * como divergência, não como erro de validação do Money.from.
 */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    /** Chamado a cada reconciliação: é onde entram o log e a métrica. */
    private readonly onResult: (result: ReconciliationResult) => void = () => {},
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.reader.read(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(`wallet ${walletId} não existe`);
    }

    const stored = signedMoney(snapshot.storedBalance, snapshot.currency);
    const calculated = signedMoney(snapshot.calculatedBalance, snapshot.currency);
    const difference = stored.subtract(calculated);

    const result: ReconciliationResult = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.checkedEntries,
    };
    this.onResult(result);
    return result;
  }
}
