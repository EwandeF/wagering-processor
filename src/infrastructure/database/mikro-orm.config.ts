import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ALL_SCHEMAS } from '../persistence/schemas';

/** Lê o ambiente a cada chamada: quem sobe o app decide a URL na hora de subir. */
export const buildConfig = () =>
  defineConfig({
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://wager:wager@localhost:5432/wager',
    entities: ALL_SCHEMAS,
    // NULL do banco vira undefined no objeto, igual aos tipos do domínio.
    forceUndefined: true,
    // O app nunca cria banco: o schema é das migrations, e subir sem banco não pode travar.
    ensureDatabase: false,
    extensions: [Migrator],
    migrations: {
      path: 'src/infrastructure/database/migrations',
      snapshot: false,
      transactional: true,
      allOrNothing: true,
    },
  });

// Os testes e o script de migrations continuam usando o padrão.
export default buildConfig();
