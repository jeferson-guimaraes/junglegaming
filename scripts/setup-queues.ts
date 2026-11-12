import { loadEnv } from '../src/infrastructure/config/env';
import {
  QUEUES,
  WAGER_TRANSACTIONS_MAX_RECEIVE_COUNT,
} from '../src/infrastructure/sqs/queue-names';
import { ensureFifoQueue, ensureFifoQueueWithDlq } from '../src/infrastructure/sqs/queues';
import { createSqsClient } from '../src/infrastructure/sqs/sqs.client';

const client = createSqsClient(loadEnv());
try {
  const entrada = await ensureFifoQueueWithDlq(client, {
    name: QUEUES.wagerTransactions,
    dlqName: QUEUES.wagerTransactionsDlq,
    maxReceiveCount: WAGER_TRANSACTIONS_MAX_RECEIVE_COUNT,
  });
  const eventosUrl = await ensureFifoQueue(client, QUEUES.wagerEvents);
  console.log(`Filas prontas:\n- ${entrada.queueUrl}\n- ${entrada.dlqUrl}\n- ${eventosUrl}`);
} finally {
  client.destroy();
}
