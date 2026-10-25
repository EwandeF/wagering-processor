import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from '../../application/submit-wager-transaction';
import { backoffDelayMs } from '../../domain/outbox-message';
import { classifyError, errorCodeOf } from './error-classification';
import { parseWagerMessage, toCommand } from './wager-message';

export type ConsumerEvent =
  | { type: 'processed'; messageId: string; status: string; duplicateMessage: boolean; idempotentReplay: boolean }
  | { type: 'business-conflict'; messageId: string; code: string }
  | { type: 'retry'; messageId: string; receiveCount: number; delaySeconds: number; code: string }
  | { type: 'dead-letter'; messageId: string; reason: 'permanent' | 'max-attempts'; code: string; receiveCount: number }
  | { type: 'released'; messageId: string }
  | { type: 'error'; error: unknown };

export interface WagerQueueConsumerOptions {
  client: SQSClient;
  queueUrl: string;
  deadLetterQueueUrl: string;
  useCase: { execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> };
  consumerName?: string;
  /** Recebimentos permitidos antes de ir para a DLQ. */
  maxReceiveCount?: number;
  batchSize?: number;
  waitTimeSeconds?: number;
  onEvent?: (event: ConsumerEvent) => void;
}

type Outcome = 'continue' | 'halt';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WagerQueueConsumer {
  private readonly consumerName: string;
  private readonly maxReceiveCount: number;
  private readonly batchSize: number;
  private readonly waitTimeSeconds: number;
  private readonly abort = new AbortController();
  private stopping = false;
  private running?: Promise<void>;

  constructor(private readonly options: WagerQueueConsumerOptions) {
    this.consumerName = options.consumerName ?? 'wager-transactions';
    this.maxReceiveCount = options.maxReceiveCount ?? 5;
    this.batchSize = options.batchSize ?? 10;
    this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
  }

  /** Inicia o laço de consumo em segundo plano. */
  start(): void {
    if (!this.running) {
      this.running = this.loop();
    }
  }

  /** SIGTERM: para de buscar, termina o que está em andamento e devolve o resto. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.running;
  }

  /** Um ciclo: busca um lote e processa. Devolve quantas mensagens recebeu. */
  async pollOnce(): Promise<number> {
    if (this.stopping) return 0;
    const response = await this.options.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitTimeSeconds,
        MessageSystemAttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = response.Messages ?? [];

    // Mesma wallet (MessageGroupId) em sequência; wallets diferentes em paralelo.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'sem-grupo';
      const list = groups.get(group);
      if (list) list.push(message);
      else groups.set(group, [message]);
    }
    await Promise.all([...groups.values()].map((list) => this.processGroup(list)));
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.emit({ type: 'error', error });
        await sleep(1000);
      }
    }
  }

  private async processGroup(list: Message[]): Promise<void> {
    for (let i = 0; i < list.length; i++) {
      if (this.stopping) {
        await this.release(list.slice(i));
        return;
      }
      let outcome: Outcome;
      try {
        outcome = await this.handle(list[i]!);
      } catch (error) {
        this.emit({ type: 'error', error });
        outcome = 'halt';
      }
      if (outcome === 'halt') {
        // Uma falha no meio do grupo: o resto espera, para não furar a ordem.
        await this.release(list.slice(i + 1));
        return;
      }
    }
  }

  private async handle(message: Message): Promise<Outcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let id = message.MessageId ?? 'desconhecido';

    try {
      const parsed = parseWagerMessage(message.Body ?? '');
      id = parsed.messageId;
      const result = await this.options.useCase.execute(toCommand(parsed, this.consumerName));
      // Só depois do commit: se este delete falhar, a reentrega cai na inbox.
      await this.delete(message);
      this.emit({
        type: 'processed',
        messageId: id,
        status: String(result.status),
        duplicateMessage: result.duplicateMessage === true,
        idempotentReplay: result.idempotentReplay,
      });
      return 'continue';
    } catch (error) {
      const kind = classifyError(error);
      const code = errorCodeOf(error);

      if (kind === 'business-terminal') {
        await this.delete(message);
        this.emit({ type: 'business-conflict', messageId: id, code });
        return 'continue';
      }
      if (kind === 'permanent') {
        await this.deadLetter(message, id, 'permanent', code, error, receiveCount);
        return 'continue';
      }
      if (receiveCount >= this.maxReceiveCount) {
        await this.deadLetter(message, id, 'max-attempts', code, error, receiveCount);
        return 'continue';
      }
      const delaySeconds = Math.ceil(backoffDelayMs(receiveCount) / 1000);
      await this.changeVisibility(message, delaySeconds);
      this.emit({ type: 'retry', messageId: id, receiveCount, delaySeconds, code });
      return 'halt';
    }
  }

  private async deadLetter(
    message: Message,
    id: string,
    reason: 'permanent' | 'max-attempts',
    code: string,
    error: unknown,
    receiveCount: number,
  ): Promise<void> {
    const text = (error instanceof Error ? error.message : String(error)).slice(0, 256);
    await this.options.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: message.Body || '(corpo vazio)',
        MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId ?? id,
        // O id do SQS é estável entre reentregas: não duplica na DLQ.
        MessageDeduplicationId: `dlq:${message.MessageId ?? id}`,
        MessageAttributes: {
          failureKind: { DataType: 'String', StringValue: reason },
          errorCode: { DataType: 'String', StringValue: code },
          errorMessage: { DataType: 'String', StringValue: text || '(sem mensagem)' },
          receiveCount: { DataType: 'String', StringValue: String(receiveCount) },
          originalMessageId: { DataType: 'String', StringValue: id },
        },
      }),
    );
    // Primeiro a DLQ, depois o delete: se o processo morrer no meio, nada se perde.
    await this.delete(message);
    this.emit({ type: 'dead-letter', messageId: id, reason, code, receiveCount });
  }

  private async release(messages: Message[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.changeVisibility(message, 0);
      } catch {
        // Sem a devolução, a mensagem volta sozinha quando o timeout de visibilidade vencer.
      }
      this.emit({ type: 'released', messageId: message.MessageId ?? 'desconhecido' });
    }
  }

  private delete(message: Message): Promise<unknown> {
    return this.options.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private changeVisibility(message: Message, seconds: number): Promise<unknown> {
    return this.options.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private emit(event: ConsumerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Um observador com defeito não pode derrubar o consumo.
    }
  }
}
