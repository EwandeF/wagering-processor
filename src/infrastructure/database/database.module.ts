import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ORM } from '../tokens';
import config from './mikro-orm.config';

@Global()
@Module({
  providers: [{ provide: ORM, useFactory: () => MikroORM.init(config) }],
  exports: [ORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
