import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Migration } from '@mikro-orm/migrations';
import { createTestDatabase, type TestDatabase } from '../support/database';

class MigrationDeFumaca extends Migration {
  override async up(): Promise<void> {
    this.addSql('create table fumaca (id int primary key, valor numeric(19,2) not null)');
  }

  override async down(): Promise<void> {
    this.addSql('drop table fumaca');
  }
}

async function tabelaExiste(db: TestDatabase, tabela: string): Promise<boolean> {
  const rows = await db.orm.em
    .getConnection()
    .execute<{ existe: boolean }[]>('select to_regclass(?) is not null as existe', [tabela]);
  return rows[0]?.existe === true;
}

describe('PostgreSQL (fumaça)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrationsList: [MigrationDeFumaca], migrate: false });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('conecta e executa uma consulta', async () => {
    const rows = await db.orm.em.getConnection().execute<{ um: number }[]>('select 1 as um');

    expect(rows[0]?.um).toBe(1);
  });

  it('aplica e reverte uma migration', async () => {
    await db.orm.migrator.up();
    expect(await tabelaExiste(db, 'fumaca')).toBe(true);

    await db.orm.migrator.down();
    expect(await tabelaExiste(db, 'fumaca')).toBe(false);
  });

  it('devolve NUMERIC como string, sem passar por number', async () => {
    const rows = await db.orm.em
      .getConnection()
      .execute<{ valor: unknown }[]>(
        "select '0.10'::numeric(19,2) + '0.20'::numeric(19,2) as valor",
      );

    expect(rows[0]?.valor).toBe('0.30');
  });
});
