import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { Money, type MoneyProps } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

/**
 * Espera por uma referência que ainda não chegou: 6 tentativas com intervalo dobrando a
 * partir de 5 s (5, 10, 20, 40, 80 e 160 s), cerca de 5 minutos no total.
 */
export const REFERENCE_RETRY_POLICY = {
  baseDelaySeconds: 5,
  maxAttempts: 6,
  /**
   * Prazo total, desde a criação, para uma transação que espera uma referência que existe mas
   * ainda não foi finalizada. Essa espera não gasta tentativas; o prazo impede que referências
   * em ciclo (A espera B, B espera A) fiquem pendentes para sempre. 15 minutos cobrem uma cadeia
   * de até duas referências pendentes em sequência (cerca de 5 minutos cada).
   */
  maxWaitSeconds: 900,
} as const;

/** Identificador de provedor das transações internas (abertura de wallet). */
export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

/** Estado como está na persistência. */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** Saldo da wallet, na moeda da wallet (pode diferir da moeda da transação rejeitada). */
  observedBalance: MoneyProps | undefined;
  processedAt: Date | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

const TERMINAIS: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const EXIGEM_REFERENCIA: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const ACEITAM_REFERENCIA: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/**
 * Transação de aposta. Transições válidas:
 *
 *   PENDING ──────────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ────► PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED e FAILED são terminais: tentar sair deles é erro de programação.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    /** Ausente apenas em OPENING. */
    public readonly roundId: string | undefined,
    /** Ausente apenas em OPENING. */
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    private _processedAt: Date | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência e o valor por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: referencia } = props;
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING é interna e não pode ser submetida');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" é reservado`);
    }
    if (referencia === '') {
      throw new InvalidTransactionError('referenceExternalTransactionId não pode ser vazio');
    }
    if (EXIGEM_REFERENCIA.has(kind) && !referencia) {
      throw new InvalidTransactionError(`${kind} exige referenceExternalTransactionId`);
    }
    if (referencia && !ACEITAM_REFERENCIA.has(kind)) {
      throw new InvalidTransactionError(`${kind} não aceita referenceExternalTransactionId`);
    }
    if (referencia && referencia === props.externalTransactionId) {
      throw new InvalidTransactionError('Uma transação não pode referenciar a si mesma');
    }
    if (money.isNegative()) {
      throw new InvalidTransactionError('O valor da transação não pode ser negativo');
    }
    if (money.isZero() && kind !== WagerTransactionKind.Loss) {
      throw new InvalidTransactionError(`${kind} exige valor maior que zero`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      money,
      referencia,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Transação interna de abertura da wallet, com identificadores sintéticos. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('OPENING exige valor maior que zero');
    }
    const idempotencyKey = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      props.walletId,
      idempotencyKey,
      idempotencyKey,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from({ amount: state.amount, currency: state.currency }),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance === undefined ? undefined : Money.from(state.observedBalance),
      state.processedAt,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  /** id interno da transação referenciada, depois de resolvida. */
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Saldo da wallet observado na última transição; é o que um replay devolve. */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(result: {
    referenceTransactionId: string | undefined;
    observedBalance: Money;
    at: Date;
  }): void {
    this.assertNotTerminal('PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = result.referenceTransactionId;
    this.conclude(result.observedBalance, result.at);
  }

  /** Rejeição por regra de negócio; falha de infraestrutura usa fail(). */
  reject(code: FailureCode, result: { observedBalance: Money; at: Date }): void {
    if (code === FailureCode.InfrastructureFailure) {
      throw new InvalidTransactionError(`${code} não é um código de rejeição de negócio`);
    }
    this.assertNotTerminal('REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.conclude(result.observedBalance, result.at);
  }

  fail(code: FailureCode, at: Date): void {
    if (code !== FailureCode.InfrastructureFailure) {
      throw new InvalidTransactionError(
        `${code} é rejeição de negócio, não falha de infraestrutura`,
      );
    }
    this.assertNotTerminal('FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /** A referência ainda não pôde ser usada; agenda a primeira nova tentativa. */
  markPendingReference(input: { observedBalance: Money; now: Date }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, 'PENDING_REFERENCE');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = input.observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = this.attemptAt(input.now);
  }

  /** Uma nova tentativa não encontrou a referência: conta e agenda a próxima com backoff. */
  registerReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'nova tentativa de referência');
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = this.attemptAt(now);
  }

  /**
   * A referência existe mas ainda não foi finalizada: reagenda sem contar tentativa.
   * A espera é limitada pela própria referência, que tem o seu prazo.
   */
  postponeReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'adiamento de referência');
    }
    this._nextReferenceAttemptAt = this.attemptAt(now);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAIS.has(this._status);
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return EXIGEM_REFERENCIA.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  hasExhaustedReferenceRetries(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts;
  }

  hasExceededReferenceWait(now: Date): boolean {
    return now.getTime() - this.createdAt.getTime() >= REFERENCE_RETRY_POLICY.maxWaitSeconds * 1000;
  }

  isReferenceRetryDue(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Direção do lançamento. ROLLBACK inverte a direção da transação referenciada. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError(
            'ROLLBACK precisa da referência para definir a direção',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS não gera lançamento');
    }
  }

  private conclude(observedBalance: Money, at: Date): void {
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  private attemptAt(now: Date): Date {
    const atrasoSegundos = REFERENCE_RETRY_POLICY.baseDelaySeconds * 2 ** this._referenceAttempts;
    return new Date(now.getTime() + atrasoSegundos * 1000);
  }

  private assertNotTerminal(destino: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, destino);
    }
  }
}
