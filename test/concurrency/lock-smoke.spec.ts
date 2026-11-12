import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EntitySchema, LockMode, OptimisticLockError } from '@mikro-orm/core';
import { Migration } from '@mikro-orm/migrations';
import Decimal from 'decimal.js';
import { createTestDatabase, type TestDatabase } from '../support/database';

class ContaRecord {
  id!: string;
  saldo!: string;
  version!: number;
}

const ContaSchema = new EntitySchema<ContaRecord>({
  class: ContaRecord,
  tableName: 'conta_fumaca',
  properties: {
    id: { type: 'uuid', primary: true },
    saldo: { type: 'decimal', precision: 19, scale: 2 },
    // version: true faz o ORM gravar com `where version = ?` e incrementar a coluna sozinho.
    version: { type: 'integer', version: true },
  },
});

class CriaContaDeFumaca extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table conta_fumaca (
        id uuid primary key,
        saldo numeric(19,2) not null check (saldo >= 0),
        version int not null
      )
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table conta_fumaca');
  }
}

const pausa = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Lock pessimista com MikroORM (fumaça)', () => {
  let db: TestDatabase;

  async function criarConta(saldo: string): Promise<string> {
    const id = randomUUID();
    await db.orm.em
      .getConnection()
      .execute('insert into conta_fumaca (id, saldo, version) values (?, ?, 1)', [id, saldo]);
    return id;
  }

  async function lerConta(id: string): Promise<{ saldo: string; version: number }> {
    const rows = await db.orm.em
      .getConnection()
      .execute<{ saldo: string; version: number }[]>(
        'select saldo, version from conta_fumaca where id = ?',
        [id],
      );
    const linha = rows[0];
    if (!linha) throw new Error('conta não encontrada');
    return linha;
  }

  async function debitar(id: string, valor: string): Promise<'ok' | 'saldo-insuficiente'> {
    const em = db.orm.em.fork();
    return em.transactional(async (tx) => {
      const conta = await tx.findOneOrFail(ContaRecord, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      await pausa(50); // alarga a janela: sem lock, as duas leriam o mesmo saldo
      const novoSaldo = new Decimal(conta.saldo).minus(valor);
      if (novoSaldo.isNegative()) return 'saldo-insuficiente';
      conta.saldo = novoSaldo.toFixed(2);
      return 'ok';
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsList: [CriaContaDeFumaca],
      entities: [ContaSchema],
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('reidrata NUMERIC como string', async () => {
    const id = await criarConta('0.30');

    const conta = await db.orm.em.fork().findOneOrFail(ContaRecord, id);

    expect(conta.saldo).toBe('0.30');
  });

  it('dois débitos de 80 concorrentes sobre saldo 100: um passa, o outro vê o saldo já debitado', async () => {
    const id = await criarConta('100.00');

    const resultados = await Promise.all([debitar(id, '80.00'), debitar(id, '80.00')]);

    expect(resultados.toSorted()).toEqual(['ok', 'saldo-insuficiente']);
    expect(await lerConta(id)).toEqual({ saldo: '20.00', version: 2 });
  });

  it('gravação com versão defasada é recusada em vez de sobrescrever (sem lock)', async () => {
    const id = await criarConta('100.00');
    const em = db.orm.em.fork();
    const conta = await em.findOneOrFail(ContaRecord, id); // lê sem lock: versão 1

    await db.orm.em
      .getConnection()
      .execute("update conta_fumaca set saldo = '50.00', version = 2 where id = ?", [id]);

    conta.saldo = '20.00';
    await expect(em.flush()).rejects.toBeInstanceOf(OptimisticLockError);
    expect(await lerConta(id)).toEqual({ saldo: '50.00', version: 2 });
  });

  it('o identity map não serve saldo velho quando a leitura é feita sob lock', async () => {
    const id = await criarConta('100.00');
    const longo = db.orm.em.fork();
    await longo.findOneOrFail(ContaRecord, id); // entra no identity map com saldo 100

    await db.orm.em
      .getConnection()
      .execute("update conta_fumaca set saldo = '50.00', version = 2 where id = ?", [id]);

    const comForkNovo = await db.orm.em.fork().transactional(async (tx) => {
      const conta = await tx.findOneOrFail(ContaRecord, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      return conta.saldo;
    });
    const comEmReaproveitado = await longo.transactional(async (tx) => {
      const conta = await tx.findOneOrFail(ContaRecord, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      return conta.saldo;
    });

    expect(comForkNovo).toBe('50.00');
    // Caracterização do MikroORM 7: a leitura com lock recarrega a entidade mesmo num
    // EntityManager que já a tinha em memória. Ainda assim o padrão do projeto é um
    // fork por operação, para não depender desse comportamento.
    expect(comEmReaproveitado).toBe('50.00');
  });
});
