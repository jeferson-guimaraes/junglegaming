import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CORRELATION_HEADER,
  correlationMiddleware,
  currentCorrelationId,
} from '@/infrastructure/observability/correlation';
import { createLogger } from '@/infrastructure/observability/logger';

const linhas: Record<string, unknown>[] = [];
const destino = new Writable({
  write(chunk, _encoding, callback) {
    linhas.push(JSON.parse(chunk.toString()));
    callback();
  },
});
const logger = createLogger({ destination: destino });

@Controller('eco')
class EcoController {
  @Get()
  async eco(): Promise<{ correlationId: string | undefined }> {
    await new Promise((resolve) => setTimeout(resolve, 5)); // atravessa uma fronteira assíncrona
    logger.info({ walletId: 'w-1' }, 'dentro do handler');
    return { correlationId: currentCorrelationId() };
  }
}

describe('correlationId', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EcoController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(correlationMiddleware);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reaproveita o cabeçalho recebido, devolve na resposta e inclui no log', async () => {
    linhas.length = 0;

    const response = await fetch(`${baseUrl}/eco`, {
      headers: { [CORRELATION_HEADER]: 'corr-123' },
    });

    expect(response.headers.get(CORRELATION_HEADER)).toBe('corr-123');
    expect(await response.json()).toEqual({ correlationId: 'corr-123' });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      level: 'info',
      msg: 'dentro do handler',
      correlationId: 'corr-123',
      walletId: 'w-1',
    });
    expect(typeof linhas[0]?.time).toBe('string');
  });

  it('gera um correlationId quando o cabeçalho não vem', async () => {
    const response = await fetch(`${baseUrl}/eco`);
    const corpo = (await response.json()) as { correlationId: string };

    expect(corpo.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get(CORRELATION_HEADER)).toBe(corpo.correlationId);
  });

  it('requisições concorrentes não misturam os identificadores', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `corr-${i}`);

    const respostas = await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(`${baseUrl}/eco`, { headers: { [CORRELATION_HEADER]: id } });
        return ((await r.json()) as { correlationId: string }).correlationId;
      }),
    );

    expect(respostas).toEqual(ids);
  });

  it('fora de uma requisição não há correlationId e o log não inventa um', () => {
    linhas.length = 0;

    logger.info('fora de contexto');

    expect(currentCorrelationId()).toBeUndefined();
    expect(linhas[0]).not.toHaveProperty('correlationId');
  });
});
