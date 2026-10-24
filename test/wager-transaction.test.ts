import { describe, expect, test } from 'bun:test';
import {
  LedgerDirection,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../src/domain/enums';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../src/domain/errors';
import { FailureCode } from '../src/domain/failure-code';
import { Money } from '../src/domain/money';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
} from '../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00Z');

const base = {
  id: 't1',
  providerId: 'prov',
  externalTransactionId: 'ext1',
  idempotencyKey: 'prov:ext1',
  payloadHash: 'h1',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  money: brl('25.00'),
  createdAt: at,
};

const make = (o: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({ ...base, kind: Kind.Bet, ...o });

const makeRefund = () =>
  make({ kind: Kind.Refund, referenceExternalTransactionId: 'ext0' });

const makeRollback = () =>
  make({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext0' });

describe('WagerTransaction.create', () => {
  test('nasce PENDING', () => {
    const t = make();
    expect(t.status).toBe(Status.Pending);
    expect(t.isTerminal()).toBe(false);
    expect(t.failureCode).toBeUndefined();
    expect(t.processedAt).toBeUndefined();
  });

  test('OPENING não pode ser submetido por create', () => {
    expect(() => make({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referência é inválido', (kind) => {
    expect(() => make({ kind })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s com referência é inválido', (kind) => {
    expect(() => make({ kind, referenceExternalTransactionId: 'x' })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each(['providerId', 'externalTransactionId', 'idempotencyKey'] as const)(
    '%s vazio é inválido',
    (field) => {
      expect(() => make({ [field]: '  ' })).toThrow(InvalidWagerTransactionError);
    },
  );

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])(
    '%s com valor zero é inválido',
    (kind) => {
      const ref = kind === Kind.Refund || kind === Kind.Rollback ? 'x' : undefined;
      expect(() =>
        make({ kind, money: brl('0.00'), referenceExternalTransactionId: ref }),
      ).toThrow(InvalidWagerTransactionError);
    },
  );

  test('LOSS aceita valor zero', () => {
    expect(make({ kind: Kind.Loss, money: brl('0.00') }).status).toBe(Status.Pending);
  });
});

describe('WagerTransaction.createOpening', () => {
  test('cria o crédito de abertura interno', () => {
    const t = WagerTransaction.createOpening(base);
    expect(t.kind).toBe(Kind.Opening);
    expect(t.status).toBe(Status.Pending);
    expect(t.requiresReference()).toBe(false);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('transições válidas', () => {
  test('PENDING -> PROCESSED', () => {
    const t = make();
    t.markProcessed(undefined, at);
    expect(t.status).toBe(Status.Processed);
    expect(t.processedAt).toEqual(at);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const t = makeRefund();
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
    expect(t.isTerminal()).toBe(false);
    t.markProcessed('ref-id', at);
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
  });

  test('PENDING_REFERENCE -> REJECTED guarda o código', () => {
    const t = makeRollback();
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('PENDING -> REJECTED e PENDING -> FAILED', () => {
    const a = make();
    a.reject(FailureCode.InsufficientFunds);
    expect(a.status).toBe(Status.Rejected);
    const b = make();
    b.fail(FailureCode.ProcessingFailed);
    expect(b.status).toBe(Status.Failed);
    expect(b.failureCode).toBe(FailureCode.ProcessingFailed);
  });
});

describe('transições inválidas', () => {
  const terminals: Record<string, () => WagerTransaction> = {
    PROCESSED: () => {
      const t = make();
      t.markProcessed(undefined, at);
      return t;
    },
    REJECTED: () => {
      const t = make();
      t.reject(FailureCode.InsufficientFunds);
      return t;
    },
    FAILED: () => {
      const t = make();
      t.fail(FailureCode.ProcessingFailed);
      return t;
    },
  };

  test.each(Object.entries(terminals))('%s é terminal: nenhuma transição sai dele', (_, build) => {
    const t = build();
    expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
  });

  test('estado terminal não é alterado pela tentativa', () => {
    const t = terminals.PROCESSED!();
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow();
    expect(t.status).toBe(Status.Processed);
    expect(t.failureCode).toBeUndefined();
  });

  test('só REFUND e ROLLBACK podem ficar PENDING_REFERENCE', () => {
    expect(() => make().markPendingReference()).toThrow(InvalidWagerTransactionError);
  });

  test('PENDING_REFERENCE não repete PENDING_REFERENCE', () => {
    const t = makeRefund();
    t.markPendingReference();
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('REFUND e ROLLBACK não são processados sem a referência', () => {
    expect(() => makeRefund().markProcessed(undefined, at)).toThrow(InvalidWagerTransactionError);
    expect(() => makeRollback().markProcessed(undefined, at)).toThrow(InvalidWagerTransactionError);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance é falso só para LOSS', () => {
    expect(make({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(make({ kind }).affectsBalance()).toBe(true);
    }
    expect(makeRefund().affectsBalance()).toBe(true);
    expect(makeRollback().affectsBalance()).toBe(true);
  });

  test('requiresReference é verdadeiro só para REFUND e ROLLBACK', () => {
    expect(makeRefund().requiresReference()).toBe(true);
    expect(makeRollback().requiresReference()).toBe(true);
    expect(make().requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash', () => {
    const t = make({ payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('xyz')).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  const bet = () => make();
  const win = () => make({ kind: Kind.Win });

  test('BET debita; WIN e REFUND creditam', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeRefund().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    expect(makeRollback().ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(makeRollback().ledgerDirectionFor(win())).toBe(LedgerDirection.Debit);
    expect(makeRollback().ledgerDirectionFor(makeRefund())).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência falha', () => {
    expect(() => makeRollback().ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ROLLBACK de ROLLBACK e de LOSS falham', () => {
    expect(() => makeRollback().ledgerDirectionFor(makeRollback())).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => makeRollback().ledgerDirectionFor(make({ kind: Kind.Loss }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('LOSS não tem direção', () => {
    expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói o estado persistido, inclusive terminal, sem revalidar', () => {
    const t = WagerTransaction.rehydrate({
      ...base,
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext0',
      status: Status.Processed,
      referenceTransactionId: 'ref-id',
      processedAt: at,
    });
    expect(t.status).toBe(Status.Processed);
    expect(t.isTerminal()).toBe(true);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });
});
