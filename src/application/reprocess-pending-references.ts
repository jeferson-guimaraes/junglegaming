import { Injectable } from '@nestjs/common';
import { FailureCode } from '@/domain/failure-code';
import { WagerTransactionStatus } from '@/domain/wager-transaction';
import { applyAndPersist } from './apply-and-persist';
import { TransientInfrastructureError } from './errors';
import { ClockPort, IdGenerator, type PendingReferenceCandidate, UnitOfWork } from './ports';

/** Pendentes examinadas por ciclo. Limita o trabalho de um ciclo, qualquer que seja a fila. */
const LOTE = 50;

export interface ReprocessSummary {
  /** Aplicadas ou rejeitadas neste ciclo (chegaram a um estado final). */
  concluidas: number;
  /** Continuam aguardando a referência. */
  aguardando: number;
  /** Outro worker já tinha cuidado, ou a tentativa ainda não venceu. */
  ignoradas: number;
  /** Falha transitória (lock, conexão): ficam para o próximo ciclo, sem gastar tentativa. */
  adiadas: number;
  /** Erro permanente: a transação foi marcada FAILED. */
  falhas: number;
}

type Desfecho = 'concluida' | 'aguardando' | 'ignorada';

/**
 * Reprocessa transações PENDING_REFERENCE cuja nova tentativa venceu. Cada pendente é tratada
 * em uma transação SQL própria, com a mesma ordem de lock do caminho normal (wallet → transação)
 * e as mesmas regras de domínio. Pode rodar em várias instâncias ao mesmo tempo: o lock da
 * wallet serializa e a releitura sob lock descarta o que outra instância já resolveu.
 */
@Injectable()
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly ids: IdGenerator,
  ) {}

  async runOnce(): Promise<ReprocessSummary> {
    const resumo: ReprocessSummary = {
      concluidas: 0,
      aguardando: 0,
      ignoradas: 0,
      adiadas: 0,
      falhas: 0,
    };
    const candidatas = await this.uow.run(({ transactions }) =>
      transactions.findDuePendingReferences(this.clock.now(), LOTE),
    );

    for (const candidata of candidatas) {
      try {
        const desfecho = await this.reprocessar(candidata);
        if (desfecho === 'concluida') resumo.concluidas += 1;
        else if (desfecho === 'aguardando') resumo.aguardando += 1;
        else resumo.ignoradas += 1;
      } catch (erro) {
        if (erro instanceof TransientInfrastructureError) {
          resumo.adiadas += 1;
          continue;
        }
        // Erro inesperado e não transitório: repetir não resolveria. A transação termina FAILED,
        // auditável, em vez de ficar em loop.
        if (await this.marcarFalha(candidata)) resumo.falhas += 1;
        else resumo.adiadas += 1;
      }
    }
    return resumo;
  }

  private reprocessar(candidata: PendingReferenceCandidate): Promise<Desfecho> {
    return this.uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(candidata.walletId);
      const transaction = await repositories.transactions.findByIdForUpdate(candidata.id);
      // O relógio é lido depois dos locks, e o estado é revalidado: outra instância pode ter
      // resolvido ou reagendado esta pendente enquanto esperávamos.
      const now = this.clock.now();
      if (!wallet || !transaction?.isReferenceRetryDue(now)) return 'ignorada';

      const outcome = await applyAndPersist(repositories, {
        wallet,
        transaction,
        novo: false,
        correlationId: this.ids.next(),
        causationId: transaction.id,
        now,
        ids: this.ids,
      });
      return outcome.transition === 'still-pending' ? 'aguardando' : 'concluida';
    });
  }

  /** Devolve false se não conseguiu marcar; a pendente será tentada de novo no próximo ciclo. */
  private async marcarFalha(candidata: PendingReferenceCandidate): Promise<boolean> {
    try {
      return await this.uow.run(async ({ wallets, transactions }) => {
        await wallets.findByIdForUpdate(candidata.walletId);
        const transaction = await transactions.findByIdForUpdate(candidata.id);
        if (transaction?.status !== WagerTransactionStatus.PendingReference) return false;
        transaction.fail(FailureCode.InfrastructureFailure, this.clock.now());
        await transactions.updatePending(transaction);
        return true;
      });
    } catch {
      return false;
    }
  }
}
