import { afterAll, describe, expect, it } from 'bun:test';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { loadEnv } from '@/infrastructure/config/env';
import { createSqsClient } from '@/infrastructure/sqs/sqs.client';

/** Servidor que aceita a conexão TCP e nunca responde: o pior caso para quem espera. */
const mudo = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: { data() {}, open() {}, close() {}, error() {} },
});

afterAll(() => {
  mudo.stop(true);
});

describe('Cliente SQS', () => {
  it('desiste de um broker que aceita a conexão e não responde, em vez de ficar preso', async () => {
    const client = createSqsClient(
      loadEnv({ SQS_ENDPOINT: `http://127.0.0.1:${mudo.port}`, CONSUMER_WAIT_TIME_SECONDS: '0' }),
    );
    const inicio = Date.now();

    await expect(client.send(new ListQueuesCommand({}))).rejects.toThrow();

    expect(Date.now() - inicio).toBeGreaterThanOrEqual(2500);
    expect(Date.now() - inicio).toBeLessThan(6000);
    client.destroy();
  }, 15_000);
});
