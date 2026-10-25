import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from '../src/application/submit-wager-transaction';
import type { WagerTransactionKind } from '../src/domain/enums';
import { createSqsClient, sqsEndpoint } from '../src/infrastructure/sqs/sqs-client';
import { type ConsumerEvent, WagerQueueConsumer } from '../src/infrastructure/sqs/wager-queue-consumer';
import { type TestWallet, uid } from './helpers';

export const sqs = createSqsClient();

export type UseCase = {
  execute(c: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult>;
};

export interface TestQueues {
  mainUrl: string;
  dlqUrl: string;
  remove(): Promise<void>;
}

/** Fila de entrada e DLQ próprias de cada arquivo de teste, apagadas no final. */
export async function createTestQueues(): Promise<TestQueues> {
  const suffix = uid().slice(-12);
  const dlqName = `wager-dlq-test-${suffix}.fifo`;
  const mainName = `wager-in-test-${suffix}.fifo`;
  const urlOf = (name: string) => `${sqsEndpoint()}/000000000000/${name}`;

  await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: mainName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '3',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:${dlqName}`,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  const mainUrl = urlOf(mainName);
  const dlqUrl = urlOf(dlqName);
  return {
    mainUrl,
    dlqUrl,
    remove: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: mainUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

export function makeConsumer(queues: TestQueues, useCase: UseCase, maxReceiveCount = 3) {
  const events: ConsumerEvent[] = [];
  const consumer = new WagerQueueConsumer({
    client: sqs,
    queueUrl: queues.mainUrl,
    deadLetterQueueUrl: queues.dlqUrl,
    useCase,
    waitTimeSeconds: 1,
    maxReceiveCount,
    onEvent: (e) => events.push(e),
  });
  return { consumer, events };
}

export const ofType = (events: ConsumerEvent[], type: ConsumerEvent['type']) =>
  events.filter((e) => e.type === type);

export function wagerMessage(
  w: TestWallet,
  ext: string,
  kind: WagerTransactionKind,
  amount: string,
  extra: object = {},
) {
  return {
    messageId: `msg-${uid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'prov',
      externalTransactionId: ext,
      idempotencyKey: `prov:${ext}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

export const enqueue = (queues: TestQueues, body: unknown, group: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.mainUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: uid(),
    }),
  );

export async function pollUntil(
  consumers: WagerQueueConsumer[],
  done: () => boolean,
  ms = 25_000,
) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await Promise.all(consumers.map((c) => c.pollOnce()));
  }
  expect(done()).toBe(true);
}

async function depth(queues: TestQueues): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.mainUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  const a = res.Attributes ?? {};
  return (
    Number(a.ApproximateNumberOfMessages ?? 0) +
    Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(a.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

export async function expectQueueEmpty(queues: TestQueues) {
  for (let i = 0; i < 20; i++) {
    if ((await depth(queues)) === 0) return;
    await Bun.sleep(300);
  }
  expect(await depth(queues)).toBe(0);
}

export async function takeFromDlq(
  queues: TestQueues,
  match: (body: string) => boolean,
  expected = 1,
) {
  const found: { body: string; attributes: Record<string, string> }[] = [];
  const deadline = Date.now() + 15_000;
  while (found.length < expected && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    for (const m of res.Messages ?? []) {
      const body = m.Body ?? '';
      if (!match(body)) continue;
      const attributes = Object.fromEntries(
        Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
      );
      found.push({ body, attributes });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queues.dlqUrl, ReceiptHandle: m.ReceiptHandle }),
      );
    }
  }
  expect(found).toHaveLength(expected);
  return found;
}

export async function sql<T>(orm: MikroORM, query: string, params: unknown[]): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as unknown as T[];
}

export const count = async (orm: MikroORM, query: string, params: unknown[]) =>
  (await sql<{ n: number }>(orm, query, params))[0]!.n;

export const outboxCount = (orm: MikroORM, walletId: string) =>
  count(orm, 'select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]);
