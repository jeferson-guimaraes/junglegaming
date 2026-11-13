import { Injectable } from '@nestjs/common';
import { ClockPort, EventPublisher, UnitOfWork } from './ports';

/** Eventos por ciclo. O trabalho de um ciclo é fixo, qualquer que seja o tamanho da fila. */
export const OUTBOX_BATCH_SIZE = 20;

/** A partir deste número de tentativas o evento é reportado para alerta. */
export const OUTBOX_ATTEMPTS_WARNING = 10;

export interface PublishSummary {
  publicados: number;
  reagendados: number;
  /** Eventos que seguem falhando há muitas tentativas: nunca são abandonados, mas pedem atenção. */
  insistentes: { id: string; eventType: string; attempts: number }[];
}

/**
 * Publica os eventos pendentes da outbox. O lote é travado com `FOR UPDATE SKIP LOCKED` e o
 * resultado de cada envio é gravado na mesma transação SQL: se o processo morrer no meio, a
 * transação é desfeita, os eventos continuam pendentes e outra instância os publica. Isso pode
 * repetir um envio, e por isso todo envio carrega o identificador do evento (entrega
 * pelo-menos-uma-vez; quem consome descarta repetidos pelo `eventId`).
 */
@Injectable()
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly publisher: EventPublisher,
  ) {}

  runOnce(): Promise<PublishSummary> {
    return this.uow.run(async ({ outbox }) => {
      const resumo: PublishSummary = { publicados: 0, reagendados: 0, insistentes: [] };
      const lote = await outbox.lockDueBatch(this.clock.now(), OUTBOX_BATCH_SIZE);

      for (const message of lote) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          resumo.publicados += 1;
        } catch {
          message.scheduleRetry(this.clock.now());
          resumo.reagendados += 1;
          if (message.attempts >= OUTBOX_ATTEMPTS_WARNING) {
            resumo.insistentes.push({
              id: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
            });
          }
          await outbox.update(message);
          // Para na primeira falha: se o broker está fora, insistir no resto do lote só manteria
          // a transação SQL aberta. Os demais seguem pendentes e voltam no próximo ciclo.
          break;
        }
        await outbox.update(message);
      }
      return resumo;
    });
  }
}
