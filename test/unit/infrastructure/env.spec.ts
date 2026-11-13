import { describe, expect, it } from 'bun:test';
import { loadEnv } from '@/infrastructure/config/env';

describe('loadEnv', () => {
  it('usa padrões que apontam para o docker-compose local', () => {
    const env = loadEnv({});

    expect(env).toMatchObject({
      port: 3000,
      dbPoolMax: 20,
      dbLockTimeoutMs: 3000,
      consumerMaxReceiveCount: 5,
      faultExitBeforeAck: false,
    });
  });

  it('recusa a flag de injeção de falha em produção', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', FAULT_EXIT_BEFORE_ACK: 'true' })).toThrow(
      /só para teste/,
    );
    expect(loadEnv({ NODE_ENV: 'test', FAULT_EXIT_BEFORE_ACK: 'true' }).faultExitBeforeAck).toBe(
      true,
    );
  });

  it('rejeita valores malformados', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadEnv({ CONSUMER_ENABLED: 'sim' })).toThrow(/CONSUMER_ENABLED/);
  });
});
