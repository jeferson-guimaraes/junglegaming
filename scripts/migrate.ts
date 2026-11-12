import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../src/infrastructure/config/env';
import { createOrmConfig } from '../src/infrastructure/persistence/orm.config';

const direcao = process.argv[2];
if (direcao !== 'up' && direcao !== 'down') {
  console.error('Uso: bun run scripts/migrate.ts <up|down>');
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig({ clientUrl: loadEnv().databaseUrl }));
try {
  if (direcao === 'up') {
    const aplicadas = await orm.migrator.up();
    console.log(`Migrations aplicadas: ${aplicadas.length}`);
  } else {
    const revertidas = await orm.migrator.down();
    console.log(`Migrations revertidas: ${revertidas.length}`);
  }
} finally {
  await orm.close(true);
}
