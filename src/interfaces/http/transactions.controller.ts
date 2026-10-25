import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { TransactionNotFoundError } from '../../application/errors';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/enums';
import { FAILURE_GUIDANCE } from '../../domain/failure-code';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerQueryService } from '../../infrastructure/persistence/query-service';
import { InvalidRequestError } from './http-errors';
import {
  asObject,
  optionalText,
  parseUuidParam,
  requireMoney,
  requireText,
  requireUuid,
} from './request-parsing';

interface StatusResponse {
  status(code: number): unknown;
}

function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header.trim() === '' || header.length > 200) {
    throw new InvalidRequestError('o header Idempotency-Key é obrigatório (1 a 200 caracteres)');
  }
  return header;
}

function requireKind(obj: Record<string, unknown>): WagerTransactionKind {
  const value = obj.kind;
  const valid = Object.values(WagerTransactionKind) as string[];
  if (typeof value !== 'string' || !valid.includes(value)) {
    throw new InvalidRequestError(`kind deve ser um de: ${valid.join(', ')}`);
  }
  return value as WagerTransactionKind;
}

/** Mapeamento único de status de transação para status HTTP. */
function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
    default:
      return 202; // PENDING e PENDING_REFERENCE: aceita, processamento pendente
  }
}

function toView(t: WagerTransaction) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    providerAction: t.failureCode ? FAILURE_GUIDANCE[t.failureCode] : undefined,
    balance: t.observedBalance?.toJSON(),
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}

@Controller()
export class TransactionsController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WagerQueryService) private readonly queries: WagerQueryService,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusResponse,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const obj = asObject(body);

    const result = await this.submit.execute({
      idempotencyKey,
      providerId: requireText(obj, 'providerId'),
      externalTransactionId: requireText(obj, 'externalTransactionId'),
      playerId: requireUuid(obj, 'playerId'),
      walletId: requireUuid(obj, 'walletId'),
      roundId: requireText(obj, 'roundId'),
      gameId: requireText(obj, 'gameId'),
      kind: requireKind(obj),
      money: requireMoney(obj, 'money'),
      referenceExternalTransactionId: optionalText(obj, 'referenceExternalTransactionId'),
    });

    res.status(httpStatusFor(result.status));
    return {
      ...result,
      providerAction: result.failureCode ? FAILURE_GUIDANCE[result.failureCode] : undefined,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const id = parseUuidParam(transactionId, 'transactionId');
    const transaction = await this.queries.findTransactionById(id);
    if (!transaction) {
      throw new TransactionNotFoundError(`transação ${id} não existe`);
    }
    return toView(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.queries.findTransactionByExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new TransactionNotFoundError(
        `transação ${externalTransactionId} do provedor ${providerId} não existe`,
      );
    }
    return toView(transaction);
  }
}
