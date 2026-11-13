import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias financeiras ficam no banco, e não só na aplicação:
 * saldo nunca negativo, idempotência, reversão única e ledger imutável.
 */
export class Migration20261112120000_schema_inicial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text,
        game_id text,
        kind text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        observed_balance numeric(19,2),
        observed_balance_currency char(3),
        processed_at timestamptz,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique
          unique (provider_id, external_transaction_id),
        constraint wager_transactions_wallet_fk foreign key (wallet_id) references wallets (id),
        -- Alvo das FKs compostas: lançamento e referência sempre na mesma wallet da transação.
        constraint wager_transactions_id_wallet_unique unique (id, wallet_id),
        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id, wallet_id)
          references wager_transactions (id, wallet_id),
        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_valid
          check (amount > 0 or (amount = 0 and kind = 'LOSS')),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_reference_by_kind check (
          case
            when kind in ('REFUND', 'ROLLBACK')
              then reference_external_transaction_id is not null
                and reference_external_transaction_id <> ''
            when kind in ('BET', 'OPENING') then reference_external_transaction_id is null
            else reference_external_transaction_id is null or reference_external_transaction_id <> ''
          end
        ),
        -- A referência resolvida só existe para quem declarou referência, nunca aponta para a
        -- própria transação e é obrigatória numa reversão processada: sem isso, o NULL
        -- escaparia do índice de reversão única.
        constraint wager_transactions_reference_resolved check (
          (reference_transaction_id is null
            or (reference_external_transaction_id is not null and reference_transaction_id <> id))
          and (not (status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK'))
            or reference_transaction_id is not null)
        ),
        constraint wager_transactions_round_game_required
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_transactions_failure_code_by_status
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_by_status
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_observed_balance_valid check (
          (observed_balance is null and observed_balance_currency is null)
          or (observed_balance is not null and observed_balance >= 0
            and observed_balance_currency is not null
            and observed_balance_currency ~ '^[A-Z]{3}$')
        ),
        constraint wager_transactions_next_attempt_by_status
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)),
        constraint wager_transactions_attempts_valid check (reference_attempts >= 0)
      )
    `);
    this.addSql(`
      create function wager_transactions_protege_estado_final() returns trigger as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'transações não podem ser removidas';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transação em estado final (%) não pode ser alterada', old.status;
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wager_transactions_estado_final
        before update or delete on wager_transactions
        for each row execute function wager_transactions_protege_estado_final()
    `);
    // Reversão única por transação, de qualquer tipo (REFUND ou ROLLBACK). WIN fica de fora.
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wallet_ledger_entries_transaction_wallet_unique
          unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balance_before_non_negative check (balance_before >= 0),
        constraint wallet_ledger_entries_balance_after_non_negative check (balance_after >= 0),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      )
    `);
    // Cursor estável para a paginação do extrato.
    this.addSql(
      'create unique index wallet_ledger_entries_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq)',
    );
    this.addSql(`
      create function wallet_ledger_entries_imutavel() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries é imutável: % não é permitido', tg_op;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_sem_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_imutavel()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_sem_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_imutavel()
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid constraint outbox_messages_pkey primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_messages_attempts_valid check (attempts >= 0),
        constraint outbox_messages_next_attempt_while_pending
          check ((published_at is null) = (next_attempt_at is not null))
      )
    `);
    // Busca do publisher: pendentes, eventos novos antes dos que estão em nova tentativa.
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (attempts, occurred_at)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_imutavel()');
    this.addSql('drop table wager_transactions');
    this.addSql('drop function wager_transactions_protege_estado_final()');
    this.addSql('drop table wallets');
  }
}
