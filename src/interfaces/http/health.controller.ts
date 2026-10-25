import type { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ORM } from '../../infrastructure/tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  /** Processo vivo. Não depende de nada externo. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Dependências alcançáveis. (O SQS entra aqui na etapa da fila.) */
  @Get('ready')
  async ready() {
    try {
      await this.orm.em.getConnection().execute('select 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', postgres: 'down' });
    }
    return { status: 'ok', postgres: 'up' };
  }
}
