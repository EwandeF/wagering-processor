import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ?? 'postgresql://wager:wager@localhost:5432/wager',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/database/migrations',
    snapshot: false,
    transactional: true,
    allOrNothing: true,
  },
});
