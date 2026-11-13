import { EventPublisher } from '@/application/ports';
import type { OutboxMessage } from '@/domain/outbox-message';

/** Publisher de teste: registra cada envio e pode falhar ou demorar sob comando. */
export class RecordingPublisher extends EventPublisher {
  enviados: string[] = [];
  /** Decide, por evento, se o envio falha. */
  falharSe: (message: OutboxMessage) => boolean = () => false;
  atrasoMs = 0;

  async publish(message: OutboxMessage): Promise<void> {
    if (this.atrasoMs > 0) await new Promise((resolve) => setTimeout(resolve, this.atrasoMs));
    if (this.falharSe(message)) throw new Error('broker indisponível (simulado)');
    this.enviados.push(message.id);
  }
}
