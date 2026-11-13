import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { createOrmConfig } from './orm.config';

/** Fecha o pool no encerramento, depois que requisições e workers já pararam. */
@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: () => {
        const env = loadEnv();
        return MikroORM.init(
          createOrmConfig({
            clientUrl: env.databaseUrl,
            poolMax: env.dbPoolMax,
            lockTimeoutMs: env.dbLockTimeoutMs,
          }),
        );
      },
    },
    DatabaseShutdown,
  ],
  exports: [MikroORM],
})
export class DatabaseModule {}
