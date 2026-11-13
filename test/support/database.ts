import { randomUUID } from 'node:crypto';
import type { Constructor, EntitySchema } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '@/infrastructure/config/env';
import { createOrmConfig } from '@/infrastructure/persistence/orm.config';

export interface TestDatabase {
  orm: MikroORM;
  name: string;
  /** URL de conexão do banco isolado, para subir processos reais contra ele. */
  url: string;
  drop(): Promise<void>;
}

interface TestDatabaseOptions {
  /** Substitui as migrations reais (usado para testar o mecanismo de migration). */
  migrationsList?: Constructor<Migration>[];
  /** Aplica as migrations ao criar. Padrão: true. */
  migrate?: boolean;
  /** Substitui os schemas de persistência reais. */
  // biome-ignore lint/suspicious/noExplicitAny: lista heterogênea de schemas
  entities?: EntitySchema<any>[];
}

/** Executa um comando administrativo (criar/remover banco) e sempre fecha a conexão. */
async function comoAdmin(sql: string): Promise<void> {
  const admin = await MikroORM.init(
    createOrmConfig({ clientUrl: loadEnv().databaseUrl, entities: [], migrationsList: [] }),
  );
  try {
    await admin.em.getConnection().execute(sql);
  } finally {
    await admin.close(true);
  }
}

/**
 * Cria um banco PostgreSQL exclusivo para o arquivo de teste e o remove ao final.
 * Isola os testes sem precisar limpar tabelas (o ledger é imutável por trigger).
 * Se a criação falhar no meio (uma migration quebrada, por exemplo), nada fica para trás.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(loadEnv().databaseUrl);
  url.pathname = `/${name}`;

  // template0 nunca aceita conexões, então a criação não espera outras sessões saírem do template.
  await comoAdmin(`create database "${name}" template template0`);
  const remover = () => comoAdmin(`drop database if exists "${name}" with (force)`);

  let orm: MikroORM | undefined;
  try {
    orm = await MikroORM.init(
      createOrmConfig({
        clientUrl: url.toString(),
        migrationsList: options.migrationsList,
        entities: options.entities,
      }),
    );
    if (options.migrate ?? true) {
      await orm.migrator.up();
    }
  } catch (erro) {
    await orm?.close(true);
    await remover();
    throw erro;
  }

  const pronto = orm;
  return {
    orm: pronto,
    name,
    url: url.toString(),
    async drop() {
      await pronto.close(true);
      await remover();
    },
  };
}
