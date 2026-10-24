import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './enums';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from './errors';
import { FailureCode } from './failure-code';
import { Money } from './money';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt' | 'observedBalance'
>;

const needsReference = (kind: WagerTransactionKind): boolean =>
  kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Porta de entrada da API e da fila. Nasce PENDING. OPENING é proibido aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING é interno e não pode ser submetido',
      );
    }
    return WagerTransaction.build(props);
  }

  /** Uso interno: crédito de abertura da wallet. */
  static createOpening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
  ): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  /** Reconstrução a partir do banco: não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const ref = props.referenceExternalTransactionId;
    if (needsReference(props.kind) && !ref) {
      throw new InvalidWagerTransactionError(
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (!needsReference(props.kind) && ref) {
      throw new InvalidWagerTransactionError(
        `${props.kind} não aceita referenceExternalTransactionId`,
      );
    }
    for (const [name, value] of [
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
    ] as const) {
      if (value.trim() === '') {
        throw new InvalidWagerTransactionError(`${name} não pode ser vazio`);
      }
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        `${props.kind} exige valor maior que zero`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      ref,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** Saldo da wallet visto ao processar; é o que os replays devolvem. */
  recordObservedBalance(balance: Money): void {
    this.assertNotTerminal();
    this._observedBalance = balance;
  }

  // ---- transições -----------------------------------------------------
  // PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
  // PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
  // PROCESSED, REJECTED, FAILED: terminais, não saem mais.

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(
        `${this.kind} só pode ser processada com a transação referenciada`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    if (!this.requiresReference()) {
      throw new InvalidWagerTransactionError(
        `${this.kind} não depende de referência`,
      );
    }
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `transação ${this.id} já está em ${this._status}`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio -------------------------------------------

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return needsReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. No ROLLBACK é o inverso da transação referenciada. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS não movimenta saldo');
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK precisa da transação referenciada para definir a direção',
          );
        }
        if (reference.kind === WagerTransactionKind.Rollback) {
          throw new InvalidWagerTransactionError('ROLLBACK não reverte ROLLBACK');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `transação ${this.id} já está em ${this._status} e não muda mais`,
      );
    }
  }
}
