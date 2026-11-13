import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ClockPort, EventPublisher } from '@/application/ports';
import { OUTBOX_BATCH_SIZE, PublishOutbox } from '@/application/publish-outbox';
import { OutboxMessage } from '@/domain/outbox-message';
import { SqsEventPublisher } from '@/infrastructure/sqs/sqs-event-publisher';
import { startApp, stopAllApps } from '../support/app-process';
import { FakeClock } from '../support/fake-clock';
import { RecordingPublisher } from '../support/recording-publisher';
import { apagarFila, drenar, sqsDeTeste, urlDaFila } from '../support/sqs';
import { type Linha, startTestApp, type TestApp } from '../support/test-app';

const FILA = `eventos-${randomUUID()}.fifo`;
const clock = new FakeClock();
const gravador = new RecordingPublisher();

let sqs: SQSClient;
/** Aplicação que publica no SQS de verdade. */
let real: TestApp;
/** Aplicação no MESMO banco, com publisher gravador e relógio controlado. */
let fake: { publish: PublishOutbox };

beforeAll(async () => {
  sqs = sqsDeTeste();
  real = await startTestApp({ SQS_EVENTS_QUEUE: FILA, DB_LOCK_TIMEOUT_MS: '15000' });
  const variante = await real.variante((b) =>
    b
      .overrideProvider(EventPublisher)
      .useValue(gravador)
      .overrideProvider(ClockPort)
      .useValue(clock),
  );
  fake = { publish: variante.app.get(PublishOutbox) };
});

afterAll(async () => {
  await stopAllApps();
  await real?.close();
  await apagarFila(sqs, FILA);
  sqs?.destroy();
});

beforeEach(async () => {
  // Cada teste começa sem pendências herdadas dos anteriores.
  await real.sql(
    'update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null',
  );
  gravador.enviados = [];
  gravador.falharSe = () => false;
  gravador.atrasoMs = 0;
});

interface LinhaOutbox {
  id: string;
  attempts: number;
  next_attempt_at: string | null;
  published_at: string | null;
}

const outboxDe = (walletId: string) =>
  real.sql<LinhaOutbox>(
    'select id, attempts, next_attempt_at, published_at from outbox_messages where aggregate_id = ? order by id',
    [walletId],
  );

/** Insere eventos direto na outbox, para montar filas grandes sem passar pela API. */
async function semear(quantidade: number, campos: Linha = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < quantidade; i++) {
    const id = Bun.randomUUIDv7();
    ids.push(id);
    await real.sql(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, 'WalletBalanceChanged', ?, ?, ?, ?)`,
      [
        id,
        campos.aggregate_id ?? randomUUID(),
        JSON.stringify({ eventId: id }),
        campos.occurred_at ?? clock.now(),
        campos.attempts ?? 0,
        campos.next_attempt_at ?? clock.now(),
      ],
    );
  }
  return ids;
}

describe('Publisher da outbox → SQS real', () => {
  it('publica os eventos pendentes na fila FIFO e marca como publicados', async () => {
    const wallet = await real.criarWallet('100.00');
    const antes = await outboxDe(wallet.id);
    expect(antes.map((e) => e.published_at)).toEqual([null, null]);

    const resumo = await real.app.get(PublishOutbox).runOnce();

    expect(resumo).toMatchObject({ publicados: 2, reagendados: 0 });
    const mensagens = await drenar(sqs, await urlDaFila(sqs, FILA), { esperadas: 2 });
    expect(mensagens).toHaveLength(2);
    for (const mensagem of mensagens) {
      const envelope = JSON.parse(mensagem.Body ?? '{}') as Linha;
      expect(antes.map((e) => e.id)).toContain(envelope.eventId as string);
      expect(envelope).toMatchObject({ aggregateId: wallet.id, version: 1 });
      expect(mensagem.Attributes?.MessageGroupId).toBe(wallet.id);
      expect(mensagem.Attributes?.MessageDeduplicationId).toBe(envelope.eventId as string);
      expect(mensagem.MessageAttributes?.eventType?.StringValue).toBe(envelope.eventType as string);
    }
    const depois = await outboxDe(wallet.id);
    expect(depois.every((e) => e.published_at !== null && e.next_attempt_at === null)).toBe(true);
    expect(depois.map((e) => e.attempts)).toEqual([0, 0]);
  });

  it('um segundo ciclo não publica de novo o que já foi publicado', async () => {
    await real.criarWallet('100.00');
    await real.app.get(PublishOutbox).runOnce();
    await drenar(sqs, await urlDaFila(sqs, FILA), { esperadas: 2 });

    const resumo = await real.app.get(PublishOutbox).runOnce();

    expect(resumo.publicados).toBe(0);
    expect(await drenar(sqs, await urlDaFila(sqs, FILA))).toHaveLength(0);
  });

  it('publicar o mesmo evento duas vezes é seguro: o broker entrega uma vez só', async () => {
    const evento = OutboxMessage.rehydrate({
      id: Bun.randomUUIDv7(),
      aggregateId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'repetido' },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      publishedAt: undefined,
    });
    const publisher = real.app.get<SqsEventPublisher>(EventPublisher);

    await publisher.publish(evento);
    await publisher.publish(evento);

    const mensagens = await drenar(sqs, await urlDaFila(sqs, FILA));
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]?.Attributes?.MessageDeduplicationId).toBe(evento.id);
  });

  it('commit feito e processo morto antes de publicar: outra instância publica', async () => {
    // Instância A grava a transação e os eventos, mas nunca publica (publisher desligado),
    // e é morta com SIGKILL: é o cenário "morreu entre o commit e a publicação".
    const fila = `eventos-${randomUUID()}.fifo`;
    const env = { DATABASE_URL: real.db.url, SQS_EVENTS_QUEUE: fila };
    const instanciaA = await startApp({ ...env, OUTBOX_PUBLISHER_ENABLED: 'false' });
    const playerId = randomUUID();
    const criacao = await fetch(`${instanciaA.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }),
    });
    const { id: walletId } = (await criacao.json()) as { id: string };
    await instanciaA.stop('SIGKILL');
    expect((await outboxDe(walletId)).map((e) => e.published_at)).toEqual([null, null]);

    try {
      await startApp({
        ...env,
        OUTBOX_PUBLISHER_ENABLED: 'true',
        OUTBOX_PUBLISHER_INTERVAL_MS: '100',
      });

      let url: string | undefined;
      for (let i = 0; i < 50 && !url; i++) {
        url = await urlDaFila(sqs, fila).catch(() => undefined);
        if (!url) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const mensagens = await drenar(sqs, url as string, { esperadas: 2, prazoMs: 10_000 });
      expect(mensagens.map((m) => m.Attributes?.MessageGroupId)).toEqual([walletId, walletId]);
      const depois = await outboxDe(walletId);
      expect(depois.every((e) => e.published_at !== null)).toBe(true);
    } finally {
      await stopAllApps();
      await apagarFila(sqs, fila);
    }
  });
});

describe('Publisher da outbox: falhas, concorrência e ordem', () => {
  it('falha de publicação reagenda com intervalo crescente e nada é perdido', async () => {
    const [id] = await semear(1);
    gravador.falharSe = () => true;
    const estado = async () =>
      (
        await real.sql<LinhaOutbox>(
          'select attempts, next_attempt_at, published_at from outbox_messages where id = ?',
          [id],
        )
      )[0];

    const primeiro = await fake.publish.runOnce();
    expect(primeiro).toMatchObject({ publicados: 0, reagendados: 1 });
    expect(await estado()).toMatchObject({ attempts: 1, published_at: null });
    expect(new Date((await estado())?.next_attempt_at as string).getTime()).toBe(
      clock.now().getTime() + 1000,
    );

    // Antes do horário agendado o evento não é tentado de novo.
    expect((await fake.publish.runOnce()).reagendados).toBe(0);

    clock.avancar(1);
    await fake.publish.runOnce();
    expect(await estado()).toMatchObject({ attempts: 2, published_at: null });
    expect(new Date((await estado())?.next_attempt_at as string).getTime()).toBe(
      clock.now().getTime() + 2000,
    );

    // O broker volta: o evento é publicado na tentativa seguinte.
    gravador.falharSe = () => false;
    clock.avancar(2);
    expect((await fake.publish.runOnce()).publicados).toBe(1);
    expect(gravador.enviados).toEqual([id as string]);
    expect(await estado()).toMatchObject({ attempts: 2, next_attempt_at: null });
    expect((await estado())?.published_at).not.toBeNull();
  });

  it('um evento que falha não impede a publicação dos outros do mesmo lote', async () => {
    const ids = await semear(5);
    gravador.falharSe = (m) => m.id === ids[2];

    const resumo = await fake.publish.runOnce();

    expect(resumo).toMatchObject({ publicados: 4, reagendados: 1 });
    expect(gravador.enviados.sort()).toEqual(ids.filter((_, i) => i !== 2).sort());
  });

  it('evento ainda não confirmado no banco não é publicado', async () => {
    const id = Bun.randomUUIDv7();
    const aberta = real.db.orm.em.fork();
    await aberta.begin();
    try {
      await aberta.getConnection().execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values (?, ?, 'WalletBalanceChanged', '{}', ?, ?)`,
        [id, randomUUID(), clock.now(), clock.now()],
        'run',
        aberta.getTransactionContext(),
      );

      await fake.publish.runOnce();

      expect(gravador.enviados).not.toContain(id);
    } finally {
      await aberta.rollback();
    }
  });

  it('publishers concorrentes pegam lotes diferentes: cada evento é enviado uma única vez, sem um esperar o outro', async () => {
    const ids = await semear(OUTBOX_BATCH_SIZE * 3);
    gravador.atrasoMs = 10; // alarga a janela em que os lotes ficam travados

    const resumos = await Promise.all([
      fake.publish.runOnce(),
      fake.publish.runOnce(),
      fake.publish.runOnce(),
    ]);

    // Se um esperasse o lock do outro, pegaria um lote vazio; com SKIP LOCKED todos trabalham.
    expect(resumos.map((r) => r.publicados)).toEqual([
      OUTBOX_BATCH_SIZE,
      OUTBOX_BATCH_SIZE,
      OUTBOX_BATCH_SIZE,
    ]);
    expect(gravador.enviados).toHaveLength(ids.length);
    expect(new Set(gravador.enviados).size).toBe(ids.length);
    expect(await real.contar('outbox_messages', 'published_at is null')).toBe(0);
  });

  it('eventos novos são publicados antes dos que estão em nova tentativa, por mais que estes sejam', async () => {
    const antigos = await semear(150, {
      attempts: 4,
      occurred_at: new Date(clock.now().getTime() - 3_600_000),
    });
    const [novo] = await semear(1);
    gravador.falharSe = (m) => antigos.includes(m.id);

    const resumo = await fake.publish.runOnce();

    expect(gravador.enviados).toEqual([novo as string]);
    expect(resumo.publicados).toBe(1);
    expect(resumo.reagendados).toBe(OUTBOX_BATCH_SIZE - 1);
  });

  it('os eventos de uma mesma operação saem na ordem em que foram gerados', async () => {
    const wallet = await real.criarWallet('100.00');
    const esperados = (await outboxDe(wallet.id)).map((e) => e.id);
    // Estes eventos foram gravados pela aplicação com o relógio real.
    clock.definir(new Date(Date.now() + 1000));

    await fake.publish.runOnce();

    expect(gravador.enviados).toEqual(esperados);
  });

  it('evento que falha há 10 tentativas ou mais é reportado, e continua pendente', async () => {
    const [id] = await semear(1, { attempts: 9 });
    gravador.falharSe = () => true;

    const resumo = await fake.publish.runOnce();

    expect(resumo.insistentes).toEqual([
      { id: id as string, eventType: 'WalletBalanceChanged', attempts: 10 },
    ]);
    expect(await real.contar('outbox_messages', 'id = ? and published_at is null', [id])).toBe(1);
  });
});
