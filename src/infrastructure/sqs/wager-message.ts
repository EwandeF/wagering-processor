import { hashPayload } from '../../application/payload-hash';
import type { SubmitWagerTransactionCommand } from '../../application/submit-wager-transaction';
import { WagerTransactionKind } from '../../domain/enums';
import { DomainError } from '../../domain/errors';
import type { MoneyProps } from '../../domain/money';
import {
  asObject,
  optionalText,
  requireMoney,
  requireText,
  requireUuid,
} from '../../interfaces/http/request-parsing';

/** A mensagem é ilegível ou fora do contrato: reenviar não adianta. */
export class MalformedMessageError extends DomainError {
  readonly code = 'MALFORMED_MESSAGE';
}

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface ParsedWagerMessage {
  messageId: string;
  occurredAt: Date;
  /** SHA-256 do JSON canônico de { type, data }: o envelope de transporte fica de fora. */
  payloadHash: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

export function parseWagerMessage(body: string): ParsedWagerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('o corpo da mensagem não é um JSON válido');
  }

  const envelope = asObject(raw, 'mensagem');
  const messageId = requireText(envelope, 'messageId');
  const type = requireText(envelope, 'type');
  if (type !== WAGER_MESSAGE_TYPE) {
    throw new MalformedMessageError(`tipo de mensagem desconhecido: ${type}`);
  }
  const occurredAt = new Date(requireText(envelope, 'occurredAt'));
  if (Number.isNaN(occurredAt.getTime())) {
    throw new MalformedMessageError('occurredAt não é uma data ISO-8601');
  }

  const data = asObject(envelope.data, 'data');
  const kinds = Object.values(WagerTransactionKind) as string[];
  if (typeof data.kind !== 'string' || !kinds.includes(data.kind)) {
    throw new MalformedMessageError(`kind deve ser um de: ${kinds.join(', ')}`);
  }

  return {
    messageId,
    occurredAt,
    payloadHash: hashPayload({ type, data }),
    data: {
      providerId: requireText(data, 'providerId'),
      externalTransactionId: requireText(data, 'externalTransactionId'),
      idempotencyKey: requireText(data, 'idempotencyKey'),
      playerId: requireUuid(data, 'playerId'),
      walletId: requireUuid(data, 'walletId'),
      roundId: requireText(data, 'roundId'),
      gameId: requireText(data, 'gameId'),
      kind: data.kind as WagerTransactionKind,
      money: requireMoney(data, 'money'),
      referenceExternalTransactionId: optionalText(data, 'referenceExternalTransactionId'),
    },
  };
}

/** O mesmo comando da API HTTP, mais a identificação da mensagem para a inbox. */
export function toCommand(
  message: ParsedWagerMessage,
  consumerName: string,
): SubmitWagerTransactionCommand {
  return {
    ...message.data,
    correlationId: message.messageId,
    inbox: {
      consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
    },
  };
}
