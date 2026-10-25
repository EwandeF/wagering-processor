import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/outbox-ports';
import type { OutboxMessage } from '../../domain/outbox-message';

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // Mesmo grupo = mesma wallet: o FIFO preserva a ordem de chegada dentro dela.
        MessageGroupId: message.aggregateId,
        // O eventId deduplica republicações dentro da janela do FIFO (otimização).
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
