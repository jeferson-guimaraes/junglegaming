import { describe, expect, it } from 'bun:test';
import { InvalidMoneyError } from '@/domain/errors';
import { Money } from '@/domain/money';
import { canonicalJson, computePayloadHash, type PayloadHashFields } from '@/domain/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '@/domain/wager-transaction';

const base: PayloadHashFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('ordena as chaves em todos os níveis e não deixa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":"x"},"b":1}',
    );
  });

  it('omite chaves com valor undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('computePayloadHash', () => {
  it('é um SHA-256 em hexadecimal do JSON canônico dos campos de negócio', () => {
    const esperado = new Bun.CryptoHasher('sha256')
      .update(
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
          '"money":{"amount":"25.00","currency":"BRL"},' +
          '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
          '"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
      )
      .digest('hex');

    expect(computePayloadHash(base)).toBe(esperado);
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('não depende da ordem das chaves do payload recebido', () => {
    const reordenado = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(reordenado)).toBe(computePayloadHash(base));
  });

  it('ignora cabeçalho e metadados de transporte: HTTP e SQS geram o mesmo hash', () => {
    const corpoHttp = { ...base };
    const dataDaMensagemSqs = {
      ...base,
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
    };

    expect(computePayloadHash(dataDaMensagemSqs)).toBe(computePayloadHash(corpoHttp));
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'outro-player' }],
    ['walletId', { walletId: 'outra-wallet' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'outro-jogo' }],
    ['kind', { kind: 'WIN' }],
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['referência', { referenceExternalTransactionId: 'transaction-100' }],
  ])('muda quando muda %s', (_campo, diferenca) => {
    expect(computePayloadHash({ ...base, ...diferenca })).not.toBe(computePayloadHash(base));
  });

  it('valor fora da escala de 2 casas não tem hash: é payload inválido', () => {
    for (const amount of ['25', '25.0', '25.000']) {
      expect(() => computePayloadHash({ ...base, money: { amount, currency: 'BRL' } })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('referência ausente, undefined ou null são equivalentes', () => {
    const comUndefined = { ...base, referenceExternalTransactionId: undefined };
    const comNull = { ...base, referenceExternalTransactionId: null };

    expect(computePayloadHash(comUndefined)).toBe(computePayloadHash(base));
    expect(computePayloadHash(comNull)).toBe(computePayloadHash(base));
  });
});

describe('Idempotency key com payload divergente', () => {
  const gravada = WagerTransaction.create({
    id: 'tx-1',
    providerId: base.providerId,
    externalTransactionId: base.externalTransactionId,
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: computePayloadHash(base),
    walletId: base.walletId,
    playerId: base.playerId,
    roundId: base.roundId,
    gameId: base.gameId,
    kind: WagerTransactionKind.Bet,
    money: Money.from(base.money),
    referenceExternalTransactionId: undefined,
    createdAt: new Date('2026-11-12T12:00:00.000Z'),
  });

  it('o mesmo payload, com as chaves em outra ordem, confere com a transação gravada: é replay', () => {
    const reenviado = { ...base, money: { currency: 'BRL', amount: '25.00' } };

    expect(gravada.matchesPayload(computePayloadHash(reenviado))).toBe(true);
  });

  it.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['tipo', { kind: 'WIN' }],
    ['rodada', { roundId: 'round-988' }],
    ['wallet', { walletId: 'outra-wallet' }],
    ['referência', { referenceExternalTransactionId: 'transaction-100' }],
  ])(
    'a mesma key com outro payload (%s) não confere: é conflito, não replay',
    (_campo, diferenca) => {
      expect(gravada.matchesPayload(computePayloadHash({ ...base, ...diferenca }))).toBe(false);
    },
  );
});
