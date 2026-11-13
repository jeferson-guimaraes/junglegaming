import type { Constructor } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';
import { Migration20261112120000_schema_inicial } from './Migration20261112120000_schema_inicial';

/**
 * Lista explícita das migrations, em ordem. Evita descoberta por glob em disco,
 * que depende de transpilar arquivos em tempo de execução.
 */
export const migrations: Constructor<Migration>[] = [Migration20261112120000_schema_inicial];
