/** Nomes das filas definidos pelo enunciado, mais a fila de saída dos eventos da outbox. */
export const QUEUES = {
  wagerTransactions: 'wager-transactions.fifo',
  wagerTransactionsDlq: 'wager-transactions-dlq.fifo',
  wagerEvents: 'wager-events.fifo',
} as const;

/** Recebimentos de uma mensagem antes de o broker movê-la para a DLQ. */
export const WAGER_TRANSACTIONS_MAX_RECEIVE_COUNT = 5;
