import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '@/infrastructure/persistence/database.module';
import { createTestDatabase, type TestDatabase } from '../support/database';

const VARIAVEIS = ['DATABASE_URL', 'DB_LOCK_TIMEOUT_MS', 'DB_POOL_MAX'] as const;

describe('DatabaseModule', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let orm: MikroORM;
  const anteriores = new Map<string, string | undefined>();

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const nome of VARIAVEIS) anteriores.set(nome, process.env[nome]);
    process.env.DATABASE_URL = db.url;
    process.env.DB_LOCK_TIMEOUT_MS = '300';
    process.env.DB_POOL_MAX = '4';

    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    if (await orm?.isConnected()) await app.close();
    for (const [nome, valor] of anteriores) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
    await db?.drop();
  });

  it('entrega um MikroORM conectado ao banco configurado', async () => {
    const rows = await orm.em
      .fork()
      .getConnection()
      .execute<{ banco: string }[]>('select current_database() as banco');

    expect(rows[0]?.banco).toBe(db.name);
  });

  it('toda conexão do pool nasce com o lock_timeout configurado', async () => {
    const consultas = Array.from({ length: 4 }, () =>
      orm.em.fork().getConnection().execute<{ lock_timeout: string }[]>('show lock_timeout'),
    );

    const valores = (await Promise.all(consultas)).map((rows) => rows[0]?.lock_timeout);

    expect(valores).toEqual(['300ms', '300ms', '300ms', '300ms']);
  });

  it('quem espera um lock além do prazo recebe erro, em vez de ficar preso', async () => {
    const walletId = randomUUID();
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', '10.00', 1, now(), now())`,
        [walletId, randomUUID()],
      );
    const travar = 'select id from wallets where id = ? for update';

    const dono = orm.em.fork();
    await dono.begin();
    try {
      await dono.getConnection().execute(travar, [walletId], 'all', dono.getTransactionContext());

      const inicio = Date.now();
      const espera = orm.em
        .fork()
        .transactional((tx) =>
          tx.getConnection().execute(travar, [walletId], 'all', tx.getTransactionContext()),
        );

      await expect(espera).rejects.toThrow(/lock timeout/);
      expect(Date.now() - inicio).toBeLessThan(2000);
    } finally {
      await dono.rollback();
    }
  });

  it('fecha o pool quando a aplicação encerra', async () => {
    expect(await orm.isConnected()).toBe(true);

    await app.close();

    expect(await orm.isConnected()).toBe(false);
  });
});
