import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/database';

const TABELAS = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
];

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

type Linha = Record<string, unknown>;

async function sql<T = Linha>(texto: string, params: unknown[] = []): Promise<T[]> {
  return db.orm.em.getConnection().execute<T[]>(texto, params);
}

async function inserir(tabela: string, linha: Linha): Promise<void> {
  const colunas = Object.keys(linha);
  await sql(
    `insert into ${tabela} (${colunas.join(', ')}) values (${colunas.map(() => '?').join(', ')})`,
    Object.values(linha),
  );
}

async function tabelasExistentes(): Promise<string[]> {
  const rows = await sql<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
  );
  return rows.map((r) => r.tablename).sort();
}

const AGORA = '2026-11-12T12:00:00.000Z';

async function novaWallet(overrides: Linha = {}): Promise<string> {
  const id = randomUUID();
  await inserir('wallets', {
    id,
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: AGORA,
    updated_at: AGORA,
    ...overrides,
  });
  return id;
}

function transacao(walletId: string, overrides: Linha = {}): Linha {
  const externo = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externo,
    idempotency_key: `provider-a:${externo}`,
    payload_hash: 'hash',
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: AGORA,
    ...overrides,
  };
}

const PROCESSADA = {
  status: 'PROCESSED',
  processed_at: AGORA,
  observed_balance: '90.00',
  observed_balance_currency: 'BRL',
};

async function novaTransacao(walletId: string, overrides: Linha = {}): Promise<string> {
  const linha = transacao(walletId, overrides);
  await inserir('wager_transactions', linha);
  return linha.id as string;
}

function lancamento(walletId: string, transactionId: string, overrides: Linha = {}): Linha {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: AGORA,
    ...overrides,
  };
}

describe('Schema: migrations', () => {
  it('sobem criando todas as tabelas', async () => {
    expect(await tabelasExistentes()).toEqual([...TABELAS].sort());
  });

  it('descem por completo e sobem de novo', async () => {
    const outro = await createTestDatabase();
    try {
      const existentes = async () => {
        const rows = await outro.orm.em.getConnection().execute<{ n: string }[]>(
          `select (select count(*) from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations')
                  + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as n`,
        );
        return Number(rows[0]?.n);
      };
      expect(await existentes()).toBeGreaterThan(TABELAS.length);

      await outro.orm.migrator.down({ to: 0 });
      expect(await existentes()).toBe(0);

      await outro.orm.migrator.up();
      expect(await existentes()).toBeGreaterThan(TABELAS.length);
    } finally {
      await outro.drop();
    }
  });
});

describe('Schema: índices das consultas previstas', () => {
  it.each([
    ['worker de pendentes', 'wager_transactions_pending_reference_idx', /PENDING_REFERENCE/],
    ['reversão única', 'wager_transactions_single_reversal', /UNIQUE.*PROCESSED/s],
    [
      'publisher do outbox',
      'outbox_messages_pending_idx',
      /attempts, occurred_at.*published_at IS NULL/s,
    ],
    ['cursor do extrato', 'wallet_ledger_entries_wallet_seq_idx', /UNIQUE.*wallet_id, seq/s],
  ])('%s: %s', async (_uso, nome, definicao) => {
    const rows = await sql<{ indexdef: string }>(
      'select indexdef from pg_indexes where indexname = ?',
      [nome],
    );

    expect(rows[0]?.indexdef).toMatch(definicao);
  });
});

describe('Schema: wallets', () => {
  it('guarda o saldo como NUMERIC exato e o devolve como string', async () => {
    const id = await novaWallet({ balance: '0.10' });

    const rows = await sql<{ soma: string; balance: string }>(
      'select balance, (balance + 0.20)::text as soma from wallets where id = ?',
      [id],
    );

    expect(rows[0]).toEqual({ balance: '0.10', soma: '0.30' });
  });

  it('rejeita uma segunda wallet do mesmo player na mesma moeda', async () => {
    const playerId = randomUUID();
    await novaWallet({ player_id: playerId });

    await expect(novaWallet({ player_id: playerId })).rejects.toThrow(
      /wallets_player_currency_unique/,
    );
  });

  it('aceita o mesmo player em outra moeda', async () => {
    const playerId = randomUUID();
    await novaWallet({ player_id: playerId });

    await novaWallet({ player_id: playerId, currency: 'USD' });
  });

  it('rejeita saldo negativo', async () => {
    await expect(novaWallet({ balance: '-0.01' })).rejects.toThrow(/wallets_balance_non_negative/);

    const id = await novaWallet({ balance: '5.00' });
    await expect(
      sql('update wallets set balance = balance - 5.01 where id = ?', [id]),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('rejeita versão menor que 1', async () => {
    await expect(novaWallet({ version: 0 })).rejects.toThrow(/wallets_version_positive/);
  });

  it('rejeita moeda fora do formato ISO-4217', async () => {
    await expect(novaWallet({ currency: 'brl' })).rejects.toThrow(/wallets_currency_format/);
  });
});

describe('Schema: wager_transactions', () => {
  let walletId: string;

  beforeAll(async () => {
    walletId = await novaWallet();
  });

  it('rejeita idempotency key duplicada', async () => {
    await novaTransacao(walletId, { idempotency_key: 'chave-1' });

    await expect(novaTransacao(walletId, { idempotency_key: 'chave-1' })).rejects.toThrow(
      /wager_transactions_idempotency_key_unique/,
    );
  });

  it('rejeita o mesmo par provider/external com outra idempotency key', async () => {
    await novaTransacao(walletId, { external_transaction_id: 'ext-dup' });

    await expect(
      novaTransacao(walletId, { external_transaction_id: 'ext-dup', idempotency_key: 'outra' }),
    ).rejects.toThrow(/wager_transactions_provider_external_unique/);
  });

  it('rejeita wallet inexistente', async () => {
    await expect(novaTransacao(randomUUID())).rejects.toThrow(/wager_transactions_wallet_fk/);
  });

  it.each([
    ['kind desconhecido', { kind: 'BONUS' }, /wager_transactions_kind_valid/],
    ['status desconhecido', { status: 'DONE' }, /wager_transactions_status_valid/],
    ['valor negativo', { amount: '-1.00' }, /wager_transactions_amount_valid/],
    ['valor zero em BET', { amount: '0.00' }, /wager_transactions_amount_valid/],
    ['REFUND sem referência', { kind: 'REFUND' }, /wager_transactions_reference_by_kind/],
    ['ROLLBACK sem referência', { kind: 'ROLLBACK' }, /wager_transactions_reference_by_kind/],
    [
      'BET com referência',
      { reference_external_transaction_id: 'ext-0' },
      /wager_transactions_reference_by_kind/,
    ],
    ['BET sem rodada', { round_id: null }, /wager_transactions_round_game_required/],
    ['BET sem jogo', { game_id: null }, /wager_transactions_round_game_required/],
    [
      'REJECTED sem failure_code',
      { ...PROCESSADA, status: 'REJECTED' },
      /wager_transactions_failure_code_by_status/,
    ],
    [
      'PROCESSED com failure_code',
      { ...PROCESSADA, failure_code: 'INSUFFICIENT_FUNDS' },
      /wager_transactions_failure_code_by_status/,
    ],
    [
      'PROCESSED sem processed_at',
      { ...PROCESSADA, processed_at: null },
      /wager_transactions_processed_at_by_status/,
    ],
    [
      'saldo observado sem moeda',
      { ...PROCESSADA, observed_balance_currency: null },
      /wager_transactions_observed_balance_valid/,
    ],
    [
      'PENDING_REFERENCE sem próxima tentativa',
      { kind: 'WIN', reference_external_transaction_id: 'ext-0', status: 'PENDING_REFERENCE' },
      /wager_transactions_next_attempt_by_status/,
    ],
    ['tentativas negativas', { reference_attempts: -1 }, /wager_transactions_attempts_valid/],
    [
      'PENDING com failure_code',
      { failure_code: 'INSUFFICIENT_FUNDS' },
      /wager_transactions_failure_code_by_status/,
    ],
    [
      'PENDING com processed_at',
      { processed_at: AGORA },
      /wager_transactions_processed_at_by_status/,
    ],
    [
      'PENDING com próxima tentativa',
      { next_reference_attempt_at: AGORA },
      /wager_transactions_next_attempt_by_status/,
    ],
    [
      'moeda observada sem saldo',
      { ...PROCESSADA, observed_balance: null },
      /wager_transactions_observed_balance_valid/,
    ],
    [
      'saldo observado negativo',
      { ...PROCESSADA, observed_balance: '-0.01' },
      /wager_transactions_observed_balance_valid/,
    ],
    [
      'moeda observada fora do formato',
      { ...PROCESSADA, observed_balance_currency: 'xx' },
      /wager_transactions_observed_balance_valid/,
    ],
    ['moeda fora do formato', { currency: 'brl' }, /wager_transactions_currency_format/],
    [
      'referência vazia',
      { kind: 'WIN', reference_external_transaction_id: '' },
      /wager_transactions_reference_by_kind/,
    ],
    [
      'reversão processada sem a referência resolvida',
      { ...PROCESSADA, kind: 'REFUND', reference_external_transaction_id: 'ext-0' },
      /wager_transactions_reference_resolved/,
    ],
  ])('rejeita %s', async (_caso, overrides, constraint) => {
    await expect(novaTransacao(walletId, overrides)).rejects.toThrow(constraint);
  });

  it('rejeita referência resolvida em quem não declarou referência, e a autorreferência', async () => {
    const bet = await novaTransacao(walletId, PROCESSADA);

    await expect(novaTransacao(walletId, { reference_transaction_id: bet })).rejects.toThrow(
      /wager_transactions_reference_resolved/,
    );

    const id = randomUUID();
    await expect(
      novaTransacao(walletId, {
        id,
        kind: 'WIN',
        reference_external_transaction_id: 'ext-0',
        reference_transaction_id: id,
      }),
    ).rejects.toThrow(/wager_transactions_reference_resolved/);
  });

  it('rejeita referência resolvida para transação de outra wallet ou inexistente', async () => {
    const outraWallet = await novaWallet();
    const betDeOutraWallet = await novaTransacao(outraWallet, PROCESSADA);
    const win = (referencia: string) => ({
      kind: 'WIN',
      reference_external_transaction_id: 'ext-0',
      reference_transaction_id: referencia,
    });

    await expect(novaTransacao(walletId, win(betDeOutraWallet))).rejects.toThrow(
      /wager_transactions_reference_fk/,
    );
    await expect(novaTransacao(walletId, win(randomUUID()))).rejects.toThrow(
      /wager_transactions_reference_fk/,
    );
  });

  it('aceita os estados legítimos que o domínio produz', async () => {
    const bet = await novaTransacao(walletId, { ...PROCESSADA, external_transaction_id: 'bet-ok' });
    const comReferencia = {
      reference_external_transaction_id: 'bet-ok',
      reference_transaction_id: bet,
    };

    await novaTransacao(walletId, { ...PROCESSADA, ...comReferencia, kind: 'WIN' });
    await novaTransacao(walletId, {
      ...PROCESSADA,
      ...comReferencia,
      kind: 'LOSS',
      amount: '0.00',
    });
    await novaTransacao(walletId, {
      kind: 'WIN',
      reference_external_transaction_id: 'ainda-nao-chegou',
      status: 'PENDING_REFERENCE',
      next_reference_attempt_at: AGORA,
      observed_balance: '100.00',
      observed_balance_currency: 'BRL',
    });
    // Rejeição por moeda: a transação é em USD e o saldo observado é o da wallet, em BRL.
    await novaTransacao(walletId, {
      ...PROCESSADA,
      currency: 'USD',
      status: 'REJECTED',
      failure_code: 'CURRENCY_MISMATCH',
    });
    // Falha de infraestrutura não grava saldo observado.
    await novaTransacao(walletId, {
      status: 'FAILED',
      failure_code: 'INFRASTRUCTURE_FAILURE',
      processed_at: AGORA,
    });
    await novaTransacao(walletId, {
      ...PROCESSADA,
      kind: 'OPENING',
      provider_id: 'internal',
      external_transaction_id: walletId,
      idempotency_key: `opening:${walletId}`,
      round_id: null,
      game_id: null,
    });
  });

  it('estado final não muda mais: UPDATE em transação finalizada e DELETE são bloqueados', async () => {
    const pendente = await novaTransacao(walletId);
    await sql(
      `update wager_transactions
          set status = 'PROCESSED', processed_at = ?, observed_balance = '90.00',
              observed_balance_currency = 'BRL'
        where id = ?`,
      [AGORA, pendente],
    );

    await expect(
      sql("update wager_transactions set status = 'PENDING', processed_at = null where id = ?", [
        pendente,
      ]),
    ).rejects.toThrow(/estado final/);
    await expect(
      sql("update wager_transactions set amount = '999.00' where id = ?", [pendente]),
    ).rejects.toThrow(/estado final/);

    const outra = await novaTransacao(walletId);
    await expect(sql('delete from wager_transactions where id = ?', [outra])).rejects.toThrow(
      /não podem ser removidas/,
    );
  });

  it('a reversão única também vale quando a segunda reversão sai de pendente para processada', async () => {
    const bet = await novaTransacao(walletId, { ...PROCESSADA, external_transaction_id: 'bet-3' });
    const referencia = {
      reference_external_transaction_id: 'bet-3',
      reference_transaction_id: bet,
    };
    await novaTransacao(walletId, { ...PROCESSADA, ...referencia, kind: 'REFUND' });
    const rollback = await novaTransacao(walletId, {
      ...referencia,
      kind: 'ROLLBACK',
      status: 'PENDING_REFERENCE',
      next_reference_attempt_at: AGORA,
    });

    await expect(
      sql(
        `update wager_transactions
            set status = 'PROCESSED', processed_at = ?, next_reference_attempt_at = null
          where id = ?`,
        [AGORA, rollback],
      ),
    ).rejects.toThrow(/wager_transactions_single_reversal/);
  });

  it('LOSS aceita valor zero', async () => {
    await novaTransacao(walletId, { kind: 'LOSS', amount: '0.00' });
  });

  it('OPENING é a única que dispensa rodada e jogo', async () => {
    await novaTransacao(walletId, { kind: 'OPENING', round_id: null, game_id: null });
  });

  it('rejeita uma segunda reversão processada da mesma transação, de qualquer tipo', async () => {
    const bet = await novaTransacao(walletId, { ...PROCESSADA, external_transaction_id: 'bet-1' });
    const reversao = (kind: string) => ({
      ...PROCESSADA,
      kind,
      reference_external_transaction_id: 'bet-1',
      reference_transaction_id: bet,
    });
    await novaTransacao(walletId, reversao('REFUND'));

    await expect(novaTransacao(walletId, reversao('ROLLBACK'))).rejects.toThrow(
      /wager_transactions_single_reversal/,
    );
    await expect(novaTransacao(walletId, reversao('REFUND'))).rejects.toThrow(
      /wager_transactions_single_reversal/,
    );
  });

  it('reversão rejeitada e WIN não ocupam a vaga de reversão única', async () => {
    const bet = await novaTransacao(walletId, { ...PROCESSADA, external_transaction_id: 'bet-2' });
    const referencia = {
      reference_external_transaction_id: 'bet-2',
      reference_transaction_id: bet,
    };

    await novaTransacao(walletId, {
      ...PROCESSADA,
      ...referencia,
      kind: 'ROLLBACK',
      status: 'REJECTED',
      failure_code: 'REVERSAL_WOULD_OVERDRAW',
    });
    await novaTransacao(walletId, { ...PROCESSADA, ...referencia, kind: 'WIN' });
    await novaTransacao(walletId, { ...PROCESSADA, ...referencia, kind: 'WIN' });
    await novaTransacao(walletId, { ...PROCESSADA, ...referencia, kind: 'REFUND' });
  });
});

describe('Schema: wallet_ledger_entries', () => {
  let walletId: string;

  beforeAll(async () => {
    walletId = await novaWallet();
  });

  it('rejeita um segundo lançamento da mesma transação na mesma wallet', async () => {
    const tx = await novaTransacao(walletId);
    await inserir('wallet_ledger_entries', lancamento(walletId, tx));

    await expect(inserir('wallet_ledger_entries', lancamento(walletId, tx))).rejects.toThrow(
      /wallet_ledger_entries_transaction_wallet_unique/,
    );
  });

  it.each([
    [
      'valor zero',
      { amount: '0.00', balance_after: '100.00' },
      /wallet_ledger_entries_amount_positive/,
    ],
    [
      'débito com aritmética errada',
      { balance_after: '90.01' },
      /wallet_ledger_entries_arithmetic/,
    ],
    [
      'crédito com aritmética errada',
      { direction: 'CREDIT', balance_after: '90.00' },
      /wallet_ledger_entries_arithmetic/,
    ],
    [
      'saldo final negativo',
      { balance_before: '5.00', balance_after: '-5.00' },
      /wallet_ledger_entries_balance_after_non_negative/,
    ],
    [
      'saldo inicial negativo',
      { direction: 'CREDIT', balance_before: '-5.00', balance_after: '5.00' },
      /wallet_ledger_entries_balance_before_non_negative/,
    ],
    ['moeda fora do formato', { currency: 'xx' }, /wallet_ledger_entries_currency_format/],
    [
      'direção desconhecida',
      { direction: 'TRANSFER' },
      /wallet_ledger_entries_(direction_valid|arithmetic)/,
    ],
  ])('rejeita %s', async (_caso, overrides, constraint) => {
    const tx = await novaTransacao(walletId);

    await expect(
      inserir('wallet_ledger_entries', lancamento(walletId, tx, overrides)),
    ).rejects.toThrow(constraint);
  });

  it('o lançamento só pode ser da wallet da própria transação', async () => {
    const outraWallet = await novaWallet();
    const tx = await novaTransacao(walletId);

    await expect(inserir('wallet_ledger_entries', lancamento(outraWallet, tx))).rejects.toThrow(
      /wallet_ledger_entries_transaction_fk/,
    );
    await expect(
      inserir('wallet_ledger_entries', lancamento(walletId, randomUUID())),
    ).rejects.toThrow(/wallet_ledger_entries_transaction_fk/);
  });

  it('aceita crédito com aritmética correta e numera os lançamentos em ordem', async () => {
    const tx1 = await novaTransacao(walletId);
    const tx2 = await novaTransacao(walletId);
    await inserir('wallet_ledger_entries', lancamento(walletId, tx1));
    await inserir(
      'wallet_ledger_entries',
      lancamento(walletId, tx2, {
        direction: 'CREDIT',
        balance_before: '90.00',
        balance_after: '100.00',
      }),
    );

    const rows = await sql<{ seq: string; transaction_id: string }>(
      'select seq, transaction_id from wallet_ledger_entries where transaction_id in (?, ?) order by seq',
      [tx1, tx2],
    );

    expect(rows.map((r) => r.transaction_id)).toEqual([tx1, tx2]);
    expect(Number(rows[1]?.seq)).toBeGreaterThan(Number(rows[0]?.seq));
  });

  it('é imutável: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const tx = await novaTransacao(walletId);
    const linha = lancamento(walletId, tx);
    await inserir('wallet_ledger_entries', linha);

    await expect(
      sql("update wallet_ledger_entries set amount = '1.00' where id = ?", [linha.id]),
    ).rejects.toThrow(/imutável/);
    await expect(sql('delete from wallet_ledger_entries where id = ?', [linha.id])).rejects.toThrow(
      /imutável/,
    );
    await expect(sql('truncate wallet_ledger_entries')).rejects.toThrow(/imutável/);

    const rows = await sql<{ amount: string }>(
      'select amount from wallet_ledger_entries where id = ?',
      [linha.id],
    );
    expect(rows[0]?.amount).toBe('10.00');
  });
});

describe('Schema: inbox_messages e outbox_messages', () => {
  it('inbox rejeita a mesma mensagem para o mesmo consumer e aceita para outro', async () => {
    const mensagem = {
      consumer_name: 'wager-transactions',
      message_id: 'msg-1',
      payload_hash: 'hash',
      received_at: AGORA,
    };
    await inserir('inbox_messages', mensagem);

    await expect(inserir('inbox_messages', mensagem)).rejects.toThrow(/inbox_messages_pkey/);
    await inserir('inbox_messages', { ...mensagem, consumer_name: 'outro-consumer' });
  });

  it('outbox exige próxima tentativa enquanto pendente e nenhuma depois de publicada', async () => {
    const evento = () => ({
      id: randomUUID(),
      aggregate_id: randomUUID(),
      event_type: 'WalletBalanceChanged',
      payload: JSON.stringify({ ok: true }),
      occurred_at: AGORA,
      next_attempt_at: AGORA,
    });
    await inserir('outbox_messages', evento());

    await expect(
      inserir('outbox_messages', { ...evento(), next_attempt_at: null }),
    ).rejects.toThrow(/outbox_messages_next_attempt_while_pending/);
    await expect(inserir('outbox_messages', { ...evento(), published_at: AGORA })).rejects.toThrow(
      /outbox_messages_next_attempt_while_pending/,
    );
    await inserir('outbox_messages', { ...evento(), next_attempt_at: null, published_at: AGORA });
  });

  it('outbox rejeita o mesmo evento duas vezes', async () => {
    const id = randomUUID();
    const evento = {
      id,
      aggregate_id: randomUUID(),
      event_type: 'WalletBalanceChanged',
      payload: JSON.stringify({ ok: true }),
      occurred_at: AGORA,
      next_attempt_at: AGORA,
    };
    await inserir('outbox_messages', evento);

    await expect(inserir('outbox_messages', evento)).rejects.toThrow(/outbox_messages_pkey/);
  });
});
