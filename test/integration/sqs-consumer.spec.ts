import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { UnitOfWork } from '@/application/ports';
import { ProcessWagerTransaction } from '@/application/process-wager-transaction';
import { parseWagerTransaction } from '@/interface/wager-transaction.input';
import { startApp, stopAllApps } from '../support/app-process';
import { faultyUnitOfWorkFactory } from '../support/faulty-unit-of-work';
import { apagarFila, drenar, enviarCru, esperar, esperarFila, sqsDeTeste } from '../support/sqs';
import { chave, type Linha, startTestApp, type TestApp, transacao } from '../support/test-app';
import { resumoDaWallet, walletsDivergentesDoLedger } from '../support/wallet-assertions';

const sufixo = randomUUID();
const FILA = `tx-${sufixo}.fifo`;
const DLQ = `tx-dlq-${sufixo}.fifo`;
const ENV_FILAS = { SQS_TRANSACTIONS_QUEUE: FILA, SQS_TRANSACTIONS_DLQ: DLQ };

let sqs: SQSClient;
let t: TestApp;
let filaUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  sqs = sqsDeTeste();
  t = await startTestApp({
    ...ENV_FILAS,
    CONSUMER_ENABLED: 'true',
    CONSUMER_WAIT_TIME_SECONDS: '1',
    CONSUMER_RETRY_BASE_SECONDS: '1',
    CONSUMER_MAX_RECEIVE_COUNT: '3',
    DB_LOCK_TIMEOUT_MS: '300',
  });
  filaUrl = await esperarFila(sqs, FILA);
  dlqUrl = await esperarFila(sqs, DLQ);
});

afterAll(async () => {
  await stopAllApps();
  await t?.close();
  await apagarFila(sqs, FILA);
  await apagarFila(sqs, DLQ);
  sqs?.destroy();
});

type Wallet = { id: string; playerId: string };
type Pedido = ReturnType<typeof transacao>;

function mensagem(pedido: Pedido, messageId = `msg-${randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-12T15:00:00.000Z',
    data: { ...pedido, idempotencyKey: `${pedido.providerId}:${pedido.externalTransactionId}` },
  };
}

const publicar = (corpo: unknown, grupo: string) =>
  enviarCru(sqs, filaUrl, typeof corpo === 'string' ? corpo : JSON.stringify(corpo), grupo);

const transacaoDe = (pedido: Pedido) =>
  t.sql<Linha>('select * from wager_transactions where external_transaction_id = ?', [
    pedido.externalTransactionId,
  ]);

const inboxDe = (messageId: string) =>
  t.sql<Linha>('select * from inbox_messages where message_id = ?', [messageId]);

/** Espera a transação do pedido existir e a devolve. */
const esperarTransacao = (pedido: Pedido, prazoMs = 10_000) =>
  esperar(async () => (await transacaoDe(pedido))[0], prazoMs, 'transação gravada');

const naDlq = async (esperadas: number, prazoMs = 10_000) =>
  drenar(sqs, dlqUrl, { esperadas, prazoMs });

const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('Consumer SQS: mesmo caso de uso da API', () => {
  it('mensagem válida gera o mesmo efeito de uma requisição HTTP, com inbox e ack', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const msg = mensagem(pedido);

    await publicar(msg, wallet.id);
    const tx = await esperarTransacao(pedido);

    expect(tx).toMatchObject({
      status: 'PROCESSED',
      kind: 'BET',
      amount: '25.00',
      idempotency_key: msg.data.idempotencyKey,
      observed_balance: '75.00',
    });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      debitos: 1,
      eventos: 4,
    });
    const [inbox] = await inboxDe(msg.messageId);
    expect(inbox).toMatchObject({
      consumer_name: 'wager-transactions',
      payload_hash: tx.payload_hash,
    });
    expect(inbox?.processed_at).not.toBeNull();
    const eventos = await t.sql<{ payload: Linha }>(
      "select payload from outbox_messages where payload->'data'->>'transactionId' = ?",
      [tx.id],
    );
    expect(eventos).toHaveLength(2);
    expect(eventos.every((e) => e.payload.causationId === msg.messageId)).toBe(true);
    // Ack: a mensagem não volta, nem depois de um tempo de visibilidade.
    expect(await drenar(sqs, filaUrl, { prazoMs: 1500 })).toHaveLength(0);
  });

  it('a mesma transação enviada depois por HTTP é reconhecida como replay (mesmo hash nos dois canais)', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await publicar(mensagem(pedido), wallet.id);
    await esperarTransacao(pedido);

    const response = await t.postTransacao(pedido, chave(pedido));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: true,
    });
    expect((await resumoDaWallet(t, wallet.id)).debitos).toBe(1);
  });

  it('rejeição por regra de negócio é gravada e a mensagem sai da fila (não vai para a DLQ)', async () => {
    const wallet = await t.criarWallet('10.00');
    const pedido = transacao(wallet);

    await publicar(mensagem(pedido), wallet.id);
    const tx = await esperarTransacao(pedido);

    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drenar(sqs, filaUrl, { prazoMs: 1500 })).toHaveLength(0);
    expect(await drenar(sqs, dlqUrl, { prazoMs: 1000 })).toHaveLength(0);
  });

  it('referência ausente fica PENDING_REFERENCE e a mensagem sai da fila', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'nao-chegou',
    });

    await publicar(mensagem(pedido), wallet.id);

    expect(await esperarTransacao(pedido)).toMatchObject({ status: 'PENDING_REFERENCE' });
  });
});

describe('Consumer SQS: inbox e reentrega', () => {
  it('a mesma mensagem entregue de novo não repete o efeito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const msg = mensagem(pedido);
    await publicar(msg, wallet.id);
    await esperarTransacao(pedido);

    await publicar(msg, wallet.id);
    await publicar(msg, wallet.id);
    const marcador = transacao(wallet, { kind: 'LOSS' });
    await publicar(mensagem(marcador), wallet.id);
    await esperarTransacao(marcador); // FIFO: as repetidas já foram tratadas antes desta

    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      debitos: 1,
    });
    expect(await transacaoDe(pedido)).toHaveLength(1);
    expect(await inboxDe(msg.messageId)).toHaveLength(1);
    expect(await drenar(sqs, dlqUrl, { prazoMs: 1000 })).toHaveLength(0);
  });

  it('o mesmo messageId com outro conteúdo é erro permanente: vai para a DLQ sem efeito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const msg = mensagem(pedido);
    await publicar(msg, wallet.id);
    await esperarTransacao(pedido);
    const adulterada = mensagem(
      { ...pedido, externalTransactionId: `outra-${randomUUID()}`, money: brl('50.00') },
      msg.messageId,
    );

    await publicar(adulterada, wallet.id);

    const [morta] = await naDlq(1);
    expect(morta?.MessageAttributes?.motivo?.StringValue).toBe('INBOX_PAYLOAD_MISMATCH');
    expect(JSON.parse(morta?.Body ?? '{}')).toEqual(adulterada);
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('75.00');
  });

  it('o mesmo messageId e conteúdo com outra idempotency key também é permanente (DLQ na hora)', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const msg = mensagem(pedido);
    await publicar(msg, wallet.id);
    await esperarTransacao(pedido);
    const outraChave = { ...msg, data: { ...msg.data, idempotencyKey: `outra-${randomUUID()}` } };

    await publicar(outraChave, wallet.id);

    const [morta] = await naDlq(1, 5000);
    expect(morta?.MessageAttributes?.motivo?.StringValue).toBe('INBOX_PAYLOAD_MISMATCH');
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('75.00');
  });

  it('falha depois do registro de inbox desfaz também o inbox', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const messageId = `msg-${randomUUID()}`;
    process.env.CONSUMER_ENABLED = 'false'; // esta variante só expõe o caso de uso
    const comFalha = await t
      .variante((b) => b.overrideProvider(UnitOfWork).useFactory(faultyUnitOfWorkFactory(1)))
      .finally(() => {
        process.env.CONSUMER_ENABLED = 'true';
      });
    const comando = {
      ...parseWagerTransaction(pedido, `${pedido.providerId}:${pedido.externalTransactionId}`),
      correlationId: 'corr-teste',
    };

    await expect(
      comFalha.app
        .get(ProcessWagerTransaction)
        .execute(comando, { consumerName: 'wager-transactions', messageId }),
    ).rejects.toThrow(/falha injetada/);

    expect(await inboxDe(messageId)).toHaveLength(0);
    expect(await transacaoDe(pedido)).toHaveLength(0);
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('100.00');
  });

  it('conflito de idempotência é erro de negócio: a mensagem é descartada, sem DLQ e sem efeito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    await publicar(mensagem(pedido), wallet.id);
    await esperarTransacao(pedido);
    const conflitante = mensagem({ ...pedido, money: brl('99.00') });

    await publicar(conflitante, wallet.id);
    const marcador = transacao(wallet, { kind: 'LOSS' });
    await publicar(mensagem(marcador), wallet.id);
    await esperarTransacao(marcador);

    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('75.00');
    expect(await inboxDe(conflitante.messageId)).toHaveLength(0);
    expect(await drenar(sqs, dlqUrl, { prazoMs: 1000 })).toHaveLength(0);
  });
});

describe('Consumer SQS: erros permanentes vão para a DLQ sem travar a wallet', () => {
  it.each([
    ['corpo que não é JSON', (_w: Wallet) => '{isto não é json', 'INVALID_PAYLOAD'],
    [
      'type desconhecido',
      (w: Wallet) => ({ ...mensagem(transacao(w)), type: 'OutraCoisa' }),
      'INVALID_PAYLOAD',
    ],
    [
      'messageId ausente',
      (w: Wallet) => ({ ...mensagem(transacao(w)), messageId: undefined }),
      'INVALID_PAYLOAD',
    ],
    ['kind OPENING', (w: Wallet) => mensagem(transacao(w, { kind: 'OPENING' })), 'INVALID_PAYLOAD'],
    [
      'valor com 3 casas',
      (w: Wallet) => mensagem(transacao(w, { money: brl('1.001') })),
      'INVALID_PAYLOAD',
    ],
    [
      'BET com referência',
      (w: Wallet) => mensagem(transacao(w, { referenceExternalTransactionId: 'x' })),
      'INVALID_PAYLOAD',
    ],
    [
      'wallet inexistente',
      (w: Wallet) => mensagem(transacao({ id: randomUUID(), playerId: w.playerId })),
      'WALLET_NOT_FOUND',
    ],
  ])('%s', async (_caso, montar, motivo) => {
    const wallet = await t.criarWallet('100.00');
    const invalida = montar(wallet);
    const valida = transacao(wallet);

    // As duas no mesmo grupo FIFO: a válida só é entregue depois que a inválida sair da frente.
    await publicar(invalida, wallet.id);
    await publicar(mensagem(valida), wallet.id);

    expect(await esperarTransacao(valida)).toMatchObject({ status: 'PROCESSED' });
    const [morta] = await naDlq(1);
    expect(morta?.MessageAttributes?.motivo?.StringValue).toBe(motivo);
    expect(morta?.Body).toBe(typeof invalida === 'string' ? invalida : JSON.stringify(invalida));
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({ balance: '75.00', debitos: 1 });
  });
});

describe('Consumer SQS: falhas transitórias', () => {
  async function travar(walletId: string) {
    const dono = t.db.orm.em.fork();
    await dono.begin();
    await dono
      .getConnection()
      .execute(
        'select id from wallets where id = ? for update',
        [walletId],
        'all',
        dono.getTransactionContext(),
      );
    return dono;
  }

  it('erro transitório de banco: a mensagem volta e é processada depois, uma única vez', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const dono = await travar(wallet.id);
    try {
      await publicar(mensagem(pedido), wallet.id);
      // Tempo para pelo menos uma tentativa falhar por lock_timeout (300 ms).
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await transacaoDe(pedido)).toHaveLength(0);
    } finally {
      await dono.rollback();
    }

    expect(await esperarTransacao(pedido, 15_000)).toMatchObject({ status: 'PROCESSED' });
    expect(await resumoDaWallet(t, wallet.id)).toMatchObject({ balance: '75.00', debitos: 1 });
    expect(await drenar(sqs, dlqUrl, { prazoMs: 1000 })).toHaveLength(0);
  });

  it('erro transitório que persiste além do limite de recebimentos: o broker move para a DLQ', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const msg = mensagem(pedido);
    const dono = await travar(wallet.id);
    try {
      await publicar(msg, wallet.id);

      // Limite de 3 recebimentos, com esperas de 1 s e 2 s entre eles.
      const [morta] = await naDlq(1, 25_000);

      expect(JSON.parse(morta?.Body ?? '{}')).toEqual(msg);
    } finally {
      await dono.rollback();
    }
    expect(await transacaoDe(pedido)).toHaveLength(0);
    expect((await resumoDaWallet(t, wallet.id)).balance).toBe('100.00');
  });
});

describe('Consumer SQS: vários consumers e processos reais', () => {
  it('dois consumers na mesma fila, com mensagens repetidas: cada transação é aplicada uma vez', async () => {
    const segundo = await t.variante((b) => b);
    expect(segundo.app).toBeDefined();
    const wallets = await Promise.all(Array.from({ length: 5 }, () => t.criarWallet('100.00')));
    const pedidos = wallets.flatMap((wallet) =>
      Array.from({ length: 6 }, () => ({
        wallet,
        pedido: transacao(wallet, { money: brl('10.00') }),
      })),
    );
    const mensagens = pedidos.map(({ wallet, pedido }) => ({ wallet, msg: mensagem(pedido) }));

    // Cada mensagem é publicada duas vezes (reentrega simulada pelo produtor).
    await Promise.all(
      [...mensagens, ...mensagens].map(({ wallet, msg }) => publicar(msg, wallet.id)),
    );
    await esperar(
      async () =>
        (await t.contar('inbox_messages', 'message_id in (?)', [
          mensagens.map((m) => m.msg.messageId),
        ])) === 30,
      20_000,
      '30 mensagens registradas no inbox',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500)); // tempo para as repetidas serem tratadas

    for (const wallet of wallets) {
      expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
        balance: '40.00',
        version: 7,
        debitos: 6,
        transacoes: 7,
      });
    }
    expect(await walletsDivergentesDoLedger(t)).toEqual([]);
    expect(await drenar(sqs, dlqUrl, { prazoMs: 1000 })).toHaveLength(0);
  });

  it('processo morto depois do commit e antes do ack: a reentrega não duplica o débito', async () => {
    const wallet = await t.criarWallet('100.00');
    const pedido = transacao(wallet);
    const filas = {
      SQS_TRANSACTIONS_QUEUE: `tx-kill-${sufixo}.fifo`,
      SQS_TRANSACTIONS_DLQ: `tx-kill-dlq-${sufixo}.fifo`,
    };
    const env = {
      ...filas,
      DATABASE_URL: t.db.url,
      CONSUMER_ENABLED: 'true',
      CONSUMER_WAIT_TIME_SECONDS: '1',
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2',
    };
    try {
      await startApp({ ...env, FAULT_EXIT_BEFORE_ACK: 'true' });
      const url = await esperarFila(sqs, filas.SQS_TRANSACTIONS_QUEUE);
      const msg = mensagem(pedido);
      await enviarCru(sqs, url, JSON.stringify(msg), wallet.id);

      // A instância grava a transação (commit) e morre sem dar ack.
      await esperarTransacao(pedido);
      expect((await resumoDaWallet(t, wallet.id)).balance).toBe('75.00');

      // Outra instância assume. A mensagem reaparece depois do tempo de visibilidade.
      await stopAllApps();
      await startApp(env);
      const marcador = transacao(wallet, { kind: 'LOSS' });
      await enviarCru(sqs, url, JSON.stringify(mensagem(marcador)), wallet.id);
      await esperarTransacao(marcador, 20_000); // FIFO: a reentrega foi tratada antes

      expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
        balance: '75.00',
        version: 2,
        debitos: 1,
      });
      expect(await transacaoDe(pedido)).toHaveLength(1);
      expect(await inboxDe(msg.messageId)).toHaveLength(1);
    } finally {
      await stopAllApps();
      await apagarFila(sqs, filas.SQS_TRANSACTIONS_QUEUE);
      await apagarFila(sqs, filas.SQS_TRANSACTIONS_DLQ);
    }
  });

  it('SIGTERM: o processo encerra limpo e nenhuma mensagem é perdida nem aplicada duas vezes', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => t.criarWallet('1000.00')));
    const filas = {
      SQS_TRANSACTIONS_QUEUE: `tx-term-${sufixo}.fifo`,
      SQS_TRANSACTIONS_DLQ: `tx-term-dlq-${sufixo}.fifo`,
    };
    const env = {
      ...filas,
      DATABASE_URL: t.db.url,
      CONSUMER_ENABLED: 'true',
      CONSUMER_WAIT_TIME_SECONDS: '1',
      // Visibilidade longa: se as mensagens recebidas e não iniciadas não fossem devolvidas no
      // encerramento, só reapareceriam depois de 60 s e o prazo abaixo estouraria.
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '60',
    };
    const pedidos = wallets.flatMap((wallet) =>
      Array.from({ length: 15 }, () => ({
        wallet,
        pedido: transacao(wallet, { money: brl('10.00') }),
      })),
    );
    try {
      const primeira = await startApp(env);
      const url = await esperarFila(sqs, filas.SQS_TRANSACTIONS_QUEUE);
      await Promise.all(
        pedidos.map(({ wallet, pedido }) =>
          enviarCru(sqs, url, JSON.stringify(mensagem(pedido)), wallet.id),
        ),
      );
      await esperar(
        async () =>
          (await t.contar('wager_transactions', "kind = 'BET' and wallet_id in (?)", [
            wallets.map((w) => w.id),
          ])) >= 5,
        15_000,
        'consumo iniciado',
      );

      const { exitCode } = await primeira.stop('SIGTERM');
      expect(exitCode).toBe(0);

      await startApp(env);
      await esperar(
        async () =>
          (await t.contar('wager_transactions', "kind = 'BET' and wallet_id in (?)", [
            wallets.map((w) => w.id),
          ])) === 60,
        30_000,
        'todas as 60 mensagens processadas',
      );
      for (const wallet of wallets) {
        expect(await resumoDaWallet(t, wallet.id)).toMatchObject({
          balance: '850.00',
          version: 16,
          debitos: 15,
        });
      }
      expect(await walletsDivergentesDoLedger(t)).toEqual([]);
    } finally {
      await stopAllApps();
      await apagarFila(sqs, filas.SQS_TRANSACTIONS_QUEUE);
      await apagarFila(sqs, filas.SQS_TRANSACTIONS_DLQ);
    }
  });
});
