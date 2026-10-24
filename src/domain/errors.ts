export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';
}
