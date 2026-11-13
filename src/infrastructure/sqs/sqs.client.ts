import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.awsRegion,
    endpoint: env.sqsEndpoint,
    // Prazos curtos: o publisher segura um lock no banco enquanto fala com o broker.
    requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
    maxAttempts: 2,
    credentials: {
      accessKeyId: env.awsAccessKeyId,
      secretAccessKey: env.awsSecretAccessKey,
    },
  });
}
