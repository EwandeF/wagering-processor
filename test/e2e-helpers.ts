import 'reflect-metadata';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { expect } from 'bun:test';
import { AppModule } from '../src/app.module';
import { createSqsClient, sqsEndpoint } from '../src/infrastructure/sqs/sqs-client';
import { ORM } from '../src/infrastructure/tokens';
import { uid } from './helpers';

const sqs = createSqsClient();

export interface E2eQueues {
  inUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  remove(): Promise<void>;
}

export async function createE2eQueues(): Promise<E2eQueues> {
  const suffix = uid().slice(-12);
  const names = {
    dlq: `e2e-dlq-${suffix}.fifo`,
    inbound: `e2e-in-${suffix}.fifo`,
    events: `e2e-events-${suffix}.fifo`,
  };
  const urlOf = (n: string) => `${sqsEndpoint()}/000000000000/${n}`;
  await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true' } }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: names.inbound,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '5',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:${names.dlq}`,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  await sqs.send(
    new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true', VisibilityTimeout: '2' } }),
  );
  const q = { inUrl: urlOf(names.inbound), dlqUrl: urlOf(names.dlq), eventsUrl: urlOf(names.events) };
  return {
    ...q,
    remove: async () => {
      for (const url of [q.inUrl, q.dlqUrl, q.eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
    },
  };
}

export interface RunningApp {
  app: INestApplication;
  url: string;
  orm: MikroORM;
}

/** Sobe o app inteiro, como em produção, com os workers ligados e filas próprias. */
export async function bootFullApp(queues: E2eQueues): Promise<RunningApp> {
  const saved = { ...process.env };
  process.env.WORKERS_ENABLED = 'true';
  process.env.WAGER_QUEUE_URL = queues.inUrl;
  process.env.WAGER_DLQ_URL = queues.dlqUrl;
  process.env.EVENTS_QUEUE_URL = queues.eventsUrl;
  process.env.OUTBOX_POLL_MS = '100';
  process.env.REFERENCE_POLL_MS = '200';
  try {
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), orm: app.get<MikroORM>(ORM, { strict: false }) };
  } finally {
    // A config é lida na subida: depois dela o ambiente do teste volta ao normal.
    process.env = saved;
  }
}

/** O banco de desenvolvimento guarda sobras de outros testes: os workers só tratam as deste. */
export async function quarantineLeftovers(orm: MikroORM): Promise<void> {
  const exec = (q: string) => orm.em.getConnection().execute(q);
  await exec('update outbox_messages set published_at = now() where published_at is null');
  await exec(
    "update wager_transactions set next_reference_attempt_at = now() + interval '1 day' where status = 'PENDING_REFERENCE'",
  );
}

export interface PublishedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  data: Record<string, any>;
}

/** Lê a fila de eventos até ter `expected` eventos distintos (ou até esgotar o prazo). */
export async function readEvents(
  eventsUrl: string,
  expected: number,
  settleMs = 0,
): Promise<{ distinct: Map<string, PublishedEvent>; received: number }> {
  const distinct = new Map<string, PublishedEvent>();
  let received = 0;
  const deadline = Date.now() + 25_000;
  let settleUntil = 0;
  while (Date.now() < deadline) {
    if (distinct.size >= expected && Date.now() >= settleUntil) break;
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 5,
      }),
    );
    for (const m of res.Messages ?? []) {
      received += 1;
      const body = JSON.parse(m.Body ?? '{}') as PublishedEvent;
      distinct.set(body.eventId, body);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: m.ReceiptHandle }));
    }
    if (distinct.size >= expected && settleUntil === 0) settleUntil = Date.now() + settleMs;
  }
  expect(distinct.size).toBeGreaterThanOrEqual(expected);
  return { distinct, received };
}

export async function waitFor(condition: () => Promise<boolean>, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  expect(await condition()).toBe(true);
}
