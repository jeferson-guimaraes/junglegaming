import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.awsRegion,
    endpoint: env.sqsEndpoint,
    // Prazo curto e que de fato aborta: o publisher segura um lock no banco enquanto fala com
    // o broker, e um broker que aceita a conexão mas não responde não pode prender o processo.
    // O prazo cobre o long polling do consumer, que espera até consumerWaitTimeSeconds.
    requestHandler: {
      requestTimeout: 3000 + env.consumerWaitTimeSeconds * 1000,
      connectionTimeout: 1000,
      throwOnRequestTimeout: true,
    },
    // Sem nova tentativa no SDK: outbox e consumer já repetem, com intervalo crescente.
    maxAttempts: 1,
    credentials: {
      accessKeyId: env.awsAccessKeyId,
      secretAccessKey: env.awsSecretAccessKey,
    },
  });
}
