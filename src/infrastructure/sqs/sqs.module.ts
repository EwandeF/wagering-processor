import type { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQS_CLIENT } from '../tokens';
import { createSqsClient } from './sqs-client';

@Global()
@Module({
  providers: [{ provide: SQS_CLIENT, useFactory: () => createSqsClient() }],
  exports: [SQS_CLIENT],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
