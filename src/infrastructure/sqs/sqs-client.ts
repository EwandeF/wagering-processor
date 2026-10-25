import { SQSClient } from '@aws-sdk/client-sqs';

/** Em produção, defina SQS_ENDPOINT vazio-ou-real; o padrão aponta para o LocalStack. */
export const sqsEndpoint = (): string => process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export const eventsQueueUrl = (): string =>
  process.env.EVENTS_QUEUE_URL ?? `${sqsEndpoint()}/000000000000/wager-events.fifo`;

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: sqsEndpoint(),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}
