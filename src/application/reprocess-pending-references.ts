import { Injectable } from '@nestjs/common';
import { DomainError } from '@/domain/errors';
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
  /** Falha transitória, ou desconhecida ainda dentro do prazo: ficam para o próximo ciclo. */
  adiadas: number;
  /** Erro permanente, ou desconhecido que persistiu além do prazo: a transação foi marcada FAILED. */
  falhas: number;
  /** O que deu errado em cada pendente adiada ou marcada como falha, para log e alerta. */
  problemas: ReprocessProblem[];
  /** Tipo e status final de cada pendente que saiu de PENDING_REFERENCE, para métrica. */
  desfechos: { kind: string; status: string }[];
}

export interface ReprocessProblem {
  transactionId: string;
  walletId: string;
  desfecho: 'adiada' | 'falha';
  erro: string;
}

/**
 * Só é permanente o que repetir não resolve: erro de domínio (estado ou dado incoerente) e
 * violação de dado ou de constraint no banco (SQLSTATE classes 22 e 23). Qualquer outro erro,
 * inclusive os sem código (queda de conexão), é tratado como transitório: marcar FAILED por
 * engano é irreversível, tentar de novo não é.
 */
export function isPermanentFailure(erro: unknown): boolean {
  if (erro instanceof TransientInfrastructureError) return false;
  if (erro instanceof DomainError) return true;
  const code = (erro as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(22|23)/.test(code);
}

function descrever(erro: unknown): string {
  const code = (erro as { code?: unknown } | null)?.code;
  const nome = erro instanceof Error ? erro.name : 'erro';
  return typeof code === 'string' ? `${nome} (${code})` : nome;
}

type Desfecho = 'aguardando' | 'ignorada' | { kind: string; status: string };

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

  /** `deveParar` é consultado entre uma pendente e outra, para o encerramento não esperar o lote todo. */
  async runOnce(deveParar: () => boolean = () => false): Promise<ReprocessSummary> {
    const resumo: ReprocessSummary = {
      concluidas: 0,
      aguardando: 0,
      ignoradas: 0,
      adiadas: 0,
      falhas: 0,
      problemas: [],
      desfechos: [],
    };
    const candidatas = await this.uow.run(({ transactions }) =>
      transactions.findDuePendingReferences(this.clock.now(), LOTE),
    );

    for (const candidata of candidatas) {
      if (deveParar()) break;
      try {
        const desfecho = await this.reprocessar(candidata);
        if (desfecho === 'aguardando') resumo.aguardando += 1;
        else if (desfecho === 'ignorada') resumo.ignoradas += 1;
        else {
          resumo.concluidas += 1;
          resumo.desfechos.push(desfecho);
        }
      } catch (erro) {
        const problema = (desfecho: 'adiada' | 'falha', causa: unknown): ReprocessProblem => ({
          transactionId: candidata.id,
          walletId: candidata.walletId,
          desfecho,
          erro: descrever(causa),
        });
        // Falha transitória conhecida (lock, conexão) nunca vira FAILED. Um erro desconhecido é
        // repetido só até o prazo total de espera: depois dele a pendente termina FAILED, para
        // não ficar para sempre na frente das outras.
        const permanente = isPermanentFailure(erro);
        if (!permanente && erro instanceof TransientInfrastructureError) {
          resumo.adiadas += 1;
          resumo.problemas.push(problema('adiada', erro));
          continue;
        }
        try {
          const marcada = await this.marcarFalha(candidata, { soSeVencida: !permanente });
          if (marcada === 'no-prazo') {
            resumo.adiadas += 1;
            resumo.problemas.push(problema('adiada', erro));
            continue;
          }
          if (marcada) resumo.desfechos.push(marcada);
          resumo.falhas += 1;
          resumo.problemas.push(problema('falha', erro));
        } catch (erroAoMarcar) {
          resumo.adiadas += 1;
          resumo.problemas.push(problema('adiada', erroAoMarcar));
        }
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
      return outcome.transition === 'still-pending'
        ? 'aguardando'
        : { kind: transaction.kind, status: transaction.status };
    });
  }

  private marcarFalha(
    candidata: PendingReferenceCandidate,
    { soSeVencida }: { soSeVencida: boolean },
  ): Promise<{ kind: string; status: string } | 'no-prazo' | undefined> {
    return this.uow.run(async ({ wallets, transactions }) => {
      await wallets.findByIdForUpdate(candidata.walletId);
      const transaction = await transactions.findByIdForUpdate(candidata.id);
      if (transaction?.status !== WagerTransactionStatus.PendingReference) return undefined;
      if (soSeVencida && !transaction.hasExceededReferenceWait(this.clock.now())) return 'no-prazo';
      transaction.fail(FailureCode.InfrastructureFailure, this.clock.now());
      await transactions.updatePending(transaction);
      return { kind: transaction.kind, status: transaction.status };
    });
  }
}
