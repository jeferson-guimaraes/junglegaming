import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Migration } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '@/infrastructure/config/env';
import { createOrmConfig } from '@/infrastructure/persistence/orm.config';
import { createTestDatabase } from '../support/database';

class MigrationQuebrada extends Migration {
  override async up(): Promise<void> {
    this.addSql('create table isto nao e sql valido');
  }
}

async function bancosDeTeste(): Promise<string[]> {
  const orm = await MikroORM.init(
    createOrmConfig({ clientUrl: loadEnv().databaseUrl, entities: [], migrationsList: [] }),
  );
  try {
    const rows = await orm.em
      .getConnection()
      .execute<{ datname: string }[]>(
        "select datname from pg_database where datname like 'test_%'",
      );
    return rows.map((r) => r.datname);
  } finally {
    await orm.close(true);
  }
}

describe('Suporte de testes: banco isolado', () => {
  it('não deixa banco para trás quando uma migration falha na criação', async () => {
    const antes = await bancosDeTeste();

    await expect(createTestDatabase({ migrationsList: [MigrationQuebrada] })).rejects.toThrow();

    expect(await bancosDeTeste()).toEqual(antes);
  });

  it('remove o banco ao final', async () => {
    const db = await createTestDatabase({ migrationsList: [] });
    expect(await bancosDeTeste()).toContain(db.name);

    await db.drop();

    expect(await bancosDeTeste()).not.toContain(db.name);
  });
});
