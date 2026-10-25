import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { wagerQueueUrl } from '../../infrastructure/sqs/sqs-client';
import { ORM, SQS_CLIENT } from '../../infrastructure/tokens';

const CHECK_TIMEOUT_MS = 2_000;

async function reachable(check: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface StatusResponse {
  status(code: number): unknown;
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Processo vivo. Não depende de nada externo. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. 503 diz qual dependência caiu. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: StatusResponse) {
    const [postgres, sqs] = await Promise.all([
      reachable(() => this.orm.em.getConnection().execute('select 1')),
      reachable(() =>
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: wagerQueueUrl(), AttributeNames: ['QueueArn'] }),
          { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
        ),
      ),
    ]);
    const ok = postgres && sqs;
    if (!ok) res.status(503);
    return {
      status: ok ? 'ok' : 'unavailable',
      postgres: postgres ? 'up' : 'down',
      sqs: sqs ? 'up' : 'down',
    };
  }
}
