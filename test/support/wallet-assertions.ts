import type { Linha } from './test-app';

export interface ResultadoHttp {
  status: number;
  body: {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance?: { amount: string; currency: string };
    idempotentReplay: boolean;
  } & Linha;
}

interface Consulta {
  sql<T = Linha>(texto: string, params?: unknown[]): Promise<T[]>;
}

/** Estado da wallet lido direto do banco: é a fonte da verdade das asserções de concorrência. */
export async function resumoDaWallet(t: Consulta, walletId: string) {
  const [linha] = await t.sql<Record<string, string | number>>(
    `select w.balance, w.version,
            (select count(*) from wallet_ledger_entries l where l.wallet_id = w.id and l.direction = 'DEBIT') as debitos,
            (select count(*) from wallet_ledger_entries l where l.wallet_id = w.id and l.direction = 'CREDIT') as creditos,
            (select count(*) from wager_transactions x where x.wallet_id = w.id) as transacoes,
            (select count(*) from outbox_messages o where o.aggregate_id = w.id) as eventos
       from wallets w where w.id = ?`,
    [walletId],
  );
  if (!linha) throw new Error('wallet não encontrada');
  return {
    balance: String(linha.balance),
    version: Number(linha.version),
    debitos: Number(linha.debitos),
    creditos: Number(linha.creditos),
    transacoes: Number(linha.transacoes),
    eventos: Number(linha.eventos),
  };
}

/**
 * Percorre o ledger na ordem de gravação e confere o encadeamento: o saldo anterior de cada
 * lançamento é o saldo posterior do lançamento de antes. A conta é feita pelo PostgreSQL.
 */
export async function cadeiaDoLedger(t: Consulta, walletId: string) {
  const [linha] = await t.sql<Record<string, string | boolean | null>>(
    `with ordenado as (
       select balance_before, balance_after,
              lag(balance_after) over (order by seq) as anterior
         from wallet_ledger_entries where wallet_id = ?
     )
     select coalesce(bool_and(anterior is null or anterior = balance_before), true) as consistente,
            min(least(balance_before, balance_after))::text as menor_saldo,
            (select balance_after::text from wallet_ledger_entries
              where wallet_id = ? order by seq desc limit 1) as saldo_final
       from ordenado`,
    [walletId, walletId],
  );
  return {
    consistente: linha?.consistente === true,
    menorSaldo: linha?.menor_saldo as string | null,
    saldoFinal: linha?.saldo_final as string | null,
  };
}

/**
 * Invariante final do enunciado, conferida em todas as wallets do banco de uma vez:
 * o saldo guardado é igual à soma dos créditos menos a soma dos débitos do ledger.
 * Devolve as wallets divergentes (o esperado é uma lista vazia).
 */
export async function walletsDivergentesDoLedger(t: Consulta) {
  return t.sql<{ id: string; balance: string; pelo_ledger: string }>(
    `select w.id, w.balance::text as balance, coalesce(l.total, 0)::text as pelo_ledger
       from wallets w
       left join (
         select wallet_id,
                sum(case when direction = 'CREDIT' then amount else -amount end) as total
           from wallet_ledger_entries group by wallet_id
       ) l on l.wallet_id = w.id
      where w.balance <> coalesce(l.total, 0)`,
  );
}
