import { MikroORM } from '@mikro-orm/postgresql';
import { type Repositories, UnitOfWork } from '@/application/ports';
import { MikroOrmUnitOfWork } from '@/infrastructure/persistence/mikro-orm-unit-of-work';

export class FalhaInjetada extends Error {
  constructor() {
    super('falha injetada na gravação do outbox');
  }
}

/**
 * Unidade de trabalho real, mas que falha na N-ésima gravação no outbox de cada execução.
 * Serve para provar que uma falha no meio da operação desfaz tudo o que veio antes.
 */
export class FaultyUnitOfWork extends UnitOfWork {
  /** Quantas gravações no outbox foram tentadas, somando todas as execuções. */
  tentativasNoOutbox = 0;

  constructor(
    private readonly real: UnitOfWork,
    private readonly falharNaGravacao: number,
  ) {
    super();
  }

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    let gravacoes = 0;
    return this.real.run((repositories) =>
      work({
        ...repositories,
        outbox: {
          ...repositories.outbox,
          insert: async (message) => {
            gravacoes += 1;
            this.tentativasNoOutbox += 1;
            if (gravacoes === this.falharNaGravacao) throw new FalhaInjetada();
            await repositories.outbox.insert(message);
          },
        },
      }),
    );
  }
}

/** Provider para `overrideProvider(UnitOfWork).useFactory(...)`. */
export function faultyUnitOfWorkFactory(falharNaGravacao: number) {
  return {
    factory: (orm: MikroORM) => new FaultyUnitOfWork(new MikroOrmUnitOfWork(orm), falharNaGravacao),
    inject: [MikroORM],
  };
}
