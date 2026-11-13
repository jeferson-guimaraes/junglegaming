import type { IntegrationEvent } from './events';

/**
 * Novas tentativas de publicação: intervalo dobrando a partir de 1 s, com teto de 60 s.
 * Não há limite de tentativas: um evento confirmado nunca é abandonado.
 */
export const OUTBOX_RETRY_POLICY = {
  baseDelaySeconds: 1,
  maxDelaySeconds: 60,
} as const;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/** Evento de integração aguardando publicação, gravado na mesma transação do efeito financeiro. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      // Pronto para envio desde a criação: a busca do publisher filtra só por nextAttemptAt.
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  /** Idempotente: uma segunda marcação mantém a primeira data. */
  markPublished(at: Date): void {
    if (!this.isPending()) return;
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto). Sem efeito se já publicado. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) return;
    this._attempts += 1;
    const atrasoSegundos = Math.min(
      OUTBOX_RETRY_POLICY.baseDelaySeconds * 2 ** (this._attempts - 1),
      OUTBOX_RETRY_POLICY.maxDelaySeconds,
    );
    this._nextAttemptAt = new Date(now.getTime() + atrasoSegundos * 1000);
  }
}
