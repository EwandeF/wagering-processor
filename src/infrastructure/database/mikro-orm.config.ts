import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ALL_SCHEMAS } from '../persistence/schemas';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ?? 'postgresql://wager:wager@localhost:5432/wager',
  entities: ALL_SCHEMAS,
  // NULL do banco vira undefined no objeto, igual aos tipos do domínio.
  forceUndefined: true,
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/database/migrations',
    snapshot: false,
    transactional: true,
    allOrNothing: true,
  },
});
