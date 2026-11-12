import type { Constructor, EntitySchema } from '@mikro-orm/core';
import { type Migration, Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrations } from './migrations';

/** Schemas de persistência da aplicação. Cada etapa acrescenta os seus. */
// biome-ignore lint/suspicious/noExplicitAny: lista heterogênea de schemas
export const entities: EntitySchema<any>[] = [];

interface OrmConfigInput {
  clientUrl: string;
  migrationsList?: Constructor<Migration>[] | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: lista heterogênea de schemas
  entities?: EntitySchema<any>[] | undefined;
}

export function createOrmConfig(input: OrmConfigInput): Options {
  return defineConfig({
    clientUrl: input.clientUrl,
    entities: input.entities ?? entities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: input.migrationsList ?? migrations,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
