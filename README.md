# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores de jogos por HTTP e por fila SQS. O saldo de cada wallet permanece correto com mensagens duplicadas, fora de ordem ou simultâneas, e com várias instâncias da aplicação rodando ao mesmo tempo.

As decisões técnicas, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime, gerenciador de pacotes e test runner | Bun 1.4 |
| Linguagem | TypeScript em modo estrito |
| Framework | NestJS 12 |
| Banco | PostgreSQL 17 |
| ORM | MikroORM 7 |
| Mensageria | AWS SQS FIFO, emulado pelo MiniStack |
| Orquestração local | Docker Compose |

## Pré-requisitos

- [Bun](https://bun.sh) 1.4 ou superior
- Docker com Docker Compose v2
- Portas livres no host: `5432` (PostgreSQL), `4566` (SQS) e `3100` a `3102` (réplicas da aplicação)

## Como rodar

### Opção 1: tudo no Docker Compose (3 réplicas)

```bash
docker compose up -d --build --wait
```

O Compose sobe o PostgreSQL e o MiniStack, roda as migrations uma vez (serviço `migrate`) e só então inicia três réplicas idênticas da aplicação:

| Réplica | Endereço |
|---|---|
| `app-1` | http://localhost:3100 |
| `app-2` | http://localhost:3101 |
| `app-3` | http://localhost:3102 |

Cada réplica atende a API HTTP, consome a fila de transações, publica os eventos da outbox e reprocessa transações pendentes. Não há balanceador: chame qualquer uma das portas.

Para conferir que subiu:

```bash
curl -s localhost:3100/health/ready
```

A resposta esperada é `{"status":"ok","checks":{"postgres":"up","sqs":"up"}}`. A aplicação é só uma API: não há página na raiz (`/` responde 404), e nesta opção nada escuta na porta 3000.

Para derrubar tudo, apagando os dados:

```bash
docker compose down -v
```

### Opção 2: aplicação local, infraestrutura no Docker

```bash
bun install
```

```bash
bun run infra:up
```

```bash
bun run migration:up
```

```bash
bun run start
```

Nesta opção a aplicação é uma única instância na porta 3000 (configurável por `PORT`). As filas são criadas pela própria aplicação no primeiro uso.

Para conferir que subiu:

```bash
curl -s localhost:3000/health/ready
```

Os exemplos deste README usam as portas da opção 1 (`3100` a `3102`); nesta opção, troque por `3000`.

## Testes

Os testes de integração e de concorrência usam o PostgreSQL e o MiniStack reais do Docker Compose; nenhum dos dois é substituído por mock. Suba a infraestrutura antes:

```bash
bun run infra:up
```

| Suíte | Comando | O que cobre |
|---|---|---|
| Unidade | `bun test` | `Money`, `Wallet`, regras de cada operação, máquina de estados, eventos, hash do payload |
| Integração | `bun run test:int` | Migrations e constraints, API, idempotência, atomicidade, inbox e reentrega, outbox, retry e DLQ, worker de pendentes, extrato, reconciliação, métricas e health checks |
| Concorrência | `bun run test:conc` | Requisições realmente paralelas, três processos reais do sistema operacional, queda e reinício no meio da carga |

Cada arquivo de teste cria um banco PostgreSQL próprio e o remove ao final, e usa filas SQS com nomes únicos. As suítes podem ser rodadas quantas vezes for preciso sem limpar nada à mão.

Verificações estáticas:

```bash
bun run typecheck
```

```bash
bun run lint
```

### Onde está cada teste de concorrência exigido

| Cenário | Arquivo |
|---|---|
| A mesma aposta 50 vezes em paralelo gera um único débito | `test/concurrency/wagering.spec.ts` |
| Saldo 100, duas apostas de 80 simultâneas | `test/concurrency/wagering.spec.ts` |
| Wallets distintas processadas em paralelo | `test/concurrency/wagering.spec.ts` |
| Três processos simultâneos (HTTP) | `test/concurrency/multi-instance.spec.ts` |
| Três processos simultâneos (HTTP e SQS nas mesmas wallets) | `test/concurrency/multi-instance-sqs.spec.ts` |
| Worker morto depois do commit e antes do ack | `test/integration/sqs-consumer.spec.ts` |
| Dois publishers sobre a mesma outbox | `test/integration/outbox-publisher.spec.ts` |
| `ROLLBACK` ou `REFUND` entregue antes da referência | `test/integration/pending-worker.spec.ts` |
| Reinício do serviço com comprovação da consistência final | `test/concurrency/multi-instance-sqs.spec.ts` |

Os testes de concorrência terminam conferindo a invariante `wallet.balance == saldo reconstruído pelo ledger` em todas as wallets usadas.

## API

Erros seguem um formato único: `{ "code": "...", "message": "..." }`.

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria uma wallet. Saldo inicial positivo gera a transação interna `OPENING` |
| `GET /wallets/:walletId` | Consulta saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Extrato paginado por cursor (limite padrão 50, máximo 200) |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo guardado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete uma transação. Exige o cabeçalho `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` | O processo está de pé |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis (503 informa qual está fora) |
| `GET /metrics` | Métricas no formato de texto do Prometheus |

### Status HTTP de `POST /wagering/transactions`

| Status | Situação | O que o provedor faz |
|---|---|---|
| 201 | Transação aplicada (`PROCESSED`) | Nada |
| 202 | Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | Consulta depois, ou reenvia a mesma requisição para ver o estado |
| 400 | Payload inválido (`INVALID_PAYLOAD`) | Corrige a requisição |
| 404 | Wallet inexistente (`WALLET_NOT_FOUND`) | Corrige a requisição |
| 409 | Conflito de idempotência (`IDEMPOTENCY_CONFLICT`) | Não reenvia: a chave já foi usada com outro conteúdo |
| 422 | Rejeitada por regra de negócio (`REJECTED`, com `failureCode`) | Decide pelo `failureCode` |
| 503 | Falha transitória (`TRANSIENT_FAILURE`, com `Retry-After`) | Reenvia a mesma requisição |

### Exemplo

Criar uma wallet:

```bash
curl -s -X POST localhost:3100/wallets -H 'content-type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Submeter uma aposta (troque `WALLET_ID` pelo `id` devolvido acima):

```bash
curl -s -X POST localhost:3101/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Repetir a mesma requisição devolve a mesma resposta com `"idempotentReplay": true` e não repete o débito.

## Filas SQS

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | Entrada de transações (mensagens `WagerTransactionRequested`) |
| `wager-transactions-dlq.fifo` | Mensagens com erro permanente, ou que esgotaram as tentativas |
| `wager-events.fifo` | Saída dos eventos de integração publicados a partir da outbox |

O produtor deve usar o `walletId` como `MessageGroupId` na fila de transações, para que as operações de uma wallet sejam entregues em ordem. A correção não depende disso: quem garante as invariantes é o banco.

Formato da mensagem de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Configuração

Todas as variáveis são opcionais; os padrões apontam para o Docker Compose local. A lista completa, com comentários, está em [.env.example](.env.example).

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | Conexão com o PostgreSQL |
| `DB_POOL_MAX` | `20` | Conexões do pool por instância |
| `DB_LOCK_TIMEOUT_MS` | `3000` | Espera máxima por lock de linha antes de responder 503 |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS |
| `CONSUMER_ENABLED` | `true` | Liga o consumer da fila de transações |
| `CONSUMER_MAX_RECEIVE_COUNT` | `5` | Recebimentos antes de o broker mover a mensagem para a DLQ |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | Liga o publisher da outbox |
| `PENDING_WORKER_ENABLED` | `true` | Liga o reprocessamento de transações pendentes |
| `SHUTDOWN_TIMEOUT_MS` | `8000` | Prazo do encerramento gracioso |
| `LOG_LEVEL` | `info` | Nível de log |

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun run dev` | Sobe com recarga automática |
| `bun run infra:up` / `bun run infra:down` | Sobe ou derruba PostgreSQL e MiniStack |
| `bun run stack:up` / `bun run stack:down` | Sobe ou derruba tudo, com as três réplicas |
| `bun run migration:up` / `bun run migration:down` | Aplica ou reverte as migrations |
| `bun run queues:setup` | Cria as filas (opcional: a aplicação cria no primeiro uso) |
| `bun test` | Testes de unidade |
| `bun run test:int` | Testes de integração |
| `bun run test:conc` | Testes de concorrência |
| `bun run typecheck` | Checagem de tipos |
| `bun run lint` / `bun run format` | Verifica ou corrige estilo (Biome) |

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, regras de negócio,
                   eventos, inbox e outbox (sem NestJS e sem ORM)
  application/     Casos de uso e portas (repositórios, unidade de trabalho, relógio, métricas)
  infrastructure/  PostgreSQL (schemas, mapeadores, migrations), SQS, workers, logs e métricas
  interface/       Entradas: controllers HTTP e consumer SQS, com a validação compartilhada
scripts/           Migrations e criação de filas pela linha de comando
test/
  unit/  integration/  concurrency/  support/
```

## Problemas comuns

- **`docker compose up --build` trava em `bun install`:** em algumas instalações do Docker a rede padrão de build não resolve DNS. Construa a imagem com a rede do host e suba sem reconstruir:

  ```bash
  docker build --network host -t wagering-app:local .
  ```

  ```bash
  docker compose up -d --wait
  ```

- **Consumer parado com aviso "falha ao receber mensagens":** acontece se a fila já existe com atributos diferentes dos configurados (por exemplo, outro `CONSUMER_MAX_RECEIVE_COUNT`); o SQS recusa a criação. Apague as filas (`docker compose down -v` recria o emulador vazio) ou volte a configuração ao valor anterior.

- **Porta ocupada:** as portas do host são configuráveis por `POSTGRES_PORT`, `SQS_PORT`, `APP_1_PORT`, `APP_2_PORT` e `APP_3_PORT`. Se mudar a do PostgreSQL ou a do SQS, ajuste também `DATABASE_URL` e `SQS_ENDPOINT` ao rodar a aplicação e os testes fora do Docker.
