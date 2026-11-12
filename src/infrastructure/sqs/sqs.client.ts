import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.awsRegion,
    endpoint: env.sqsEndpoint,
    credentials: {
      accessKeyId: env.awsAccessKeyId,
      secretAccessKey: env.awsSecretAccessKey,
    },
  });
}
