import type { Constructor } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';

/**
 * Lista explícita das migrations, em ordem. Evita descoberta por glob em disco,
 * que depende de transpilar arquivos em tempo de execução.
 */
export const migrations: Constructor<Migration>[] = [];
