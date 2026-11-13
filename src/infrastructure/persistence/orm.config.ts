import type { Constructor, EntitySchema } from '@mikro-orm/core';
import { type Migration, Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrations } from './migrations';
import { LedgerEntrySchema, OutboxSchema, WagerTransactionSchema, WalletSchema } from './records';

/** Schemas de persistência da aplicação. */
// biome-ignore lint/suspicious/noExplicitAny: lista heterogênea de schemas
export const entities: EntitySchema<any>[] = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxSchema,
];

interface OrmConfigInput {
  clientUrl: string;
  migrationsList?: Constructor<Migration>[] | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: lista heterogênea de schemas
  entities?: EntitySchema<any>[] | undefined;
  /** Máximo de conexões do pool. Sem valor, vale o padrão do driver. */
  poolMax?: number | undefined;
  /** Prazo de espera por lock de linha; estourado, o PostgreSQL devolve erro (55P03). */
  lockTimeoutMs?: number | undefined;
}

export function createOrmConfig(input: OrmConfigInput): Options {
  return defineConfig({
    clientUrl: input.clientUrl,
    entities: input.entities ?? entities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    ...(input.poolMax === undefined ? {} : { pool: { max: input.poolMax } }),
    // Parâmetro de sessão aplicado pelo servidor a cada conexão nova do pool.
    ...(input.lockTimeoutMs === undefined
      ? {}
      : { driverOptions: { options: `-c lock_timeout=${input.lockTimeoutMs}` } }),
    migrations: {
      migrationsList: input.migrationsList ?? migrations,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
