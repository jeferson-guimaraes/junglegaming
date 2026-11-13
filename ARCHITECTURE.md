# Arquitetura

Este documento registra as decisões do projeto, o motivo de cada uma, os trade-offs aceitos e as limitações conhecidas. Para instalar e rodar, veja o [README.md](README.md).

## 1. Visão geral

Uma única aplicação NestJS, em que toda instância faz quatro coisas:

- atende a API HTTP;
- consome a fila `wager-transactions.fifo`;
- publica os eventos da outbox em `wager-events.fifo`;
- reprocessa transações que esperam uma referência.

HTTP e SQS chegam ao **mesmo caso de uso** (`ProcessWagerTransaction`). Todo efeito financeiro acontece em **uma transação SQL**, sob o lock da wallet. As garantias finais (saldo não negativo, unicidade, reversão única, ledger imutável) estão no schema do PostgreSQL; a aplicação as respeita, mas não é a última linha de defesa.

```
 provedor ── HTTP ──┐
                    ├──► ProcessWagerTransaction ──► PostgreSQL (1 transação SQL)
 provedor ── SQS ───┘        │                        wallet · transação · ledger
                             │                        inbox · outbox
                    regras de domínio
                                                      outbox ──► publisher ──► wager-events.fifo
                                                      pendentes ──► worker ──► mesmo passo de aplicação
```

### Camadas

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, regras de cada operação, eventos, inbox, outbox | só `decimal.js` e `node:crypto` |
| `application` | casos de uso e portas (`UnitOfWork`, repositórios, `ClockPort`, `IdGenerator`, `EventPublisher`, `Metrics`) | `domain`; do NestJS, só o decorator `@Injectable` |
| `infrastructure` | MikroORM (schemas, mapeadores, migrations), SQS, workers, logs, métricas | `application`, `domain` |
| `interface` | controllers HTTP, consumer SQS, validação de entrada | `application`; de `infrastructure`, só o que é da borda: configuração, logger, registro de métricas, cliente SQS e a conexão usada pelo health check |

Um teste (`test/unit/domain/domain-purity.spec.ts`) falha se o domínio importar NestJS, ORM ou qualquer outra biblioteca.

## 2. Dinheiro

- **No domínio:** a classe `Money` guarda o valor em `decimal.js`, com precisão sobrando para o teto de `NUMERIC(19,2)`. Não há `number` em nenhum ponto do caminho.
- **Nos contratos (HTTP, fila, eventos):** `{ "amount": "25.00", "currency": "BRL" }`, sempre string decimal.
- **No banco:** `NUMERIC(19,2)`, lido e gravado como string. As somas da reconciliação são feitas pelo próprio PostgreSQL, em `NUMERIC`.
- **Entrada:** escala fixa de 2 casas, na entrada e na saída. `"10"`, `"10.5"` e `"10.001"` são rejeitados: o valor nunca é normalizado nem arredondado. Também são rejeitados valor negativo, notação científica, zeros à esquerda, separador de milhar e valor acima do teto.
- **Moeda:** código ISO-4217 de 3 letras maiúsculas. Operar valores de moedas diferentes é erro.

## 3. ORM e persistência

**MikroORM**, opção preferencial do enunciado.

- **Modelos de persistência separados do domínio.** As tabelas são descritas por `EntitySchema` em classes simples (`WalletRecord` etc.), sem decorators nas classes de domínio. Mapeadores convertem entre os dois lados; o domínio é reconstruído por `rehydrate`.
- **Unidade de trabalho como porta.** `UnitOfWork.run(work)` abre um `EntityManager` novo (`em.fork()`) e executa `work` dentro de `em.transactional()`. Nenhum estado em memória passa de uma requisição, mensagem ou ciclo de worker para outro.
- **Escritas imediatas.** Os repositórios usam `em.insert` e `em.nativeUpdate`, e não o flush automático do ORM. A ordem dos comandos SQL é a ordem do código, e o update da wallet é explicitamente condicionado à versão.
- **Migrations** versionadas e reversíveis, em lista explícita no código. O `down` é testado: remove tabelas, funções e triggers, e o `up` roda de novo.

## 4. Schema

As garantias que não podem depender só do código estão no banco.

| Tabela | Garantias |
|---|---|
| `wallets` | uma wallet por player e moeda (`UNIQUE`); `CHECK (balance >= 0)`; `CHECK (version >= 1)` |
| `wager_transactions` | `UNIQUE (idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; índice único parcial que permite **uma só reversão processada por transação**; `CHECK` de tipo, status e valor; referência obrigatória em `REFUND` e `ROLLBACK`, proibida em `BET`; coerência de estado (código de falha só em transação rejeitada ou falha, data de processamento só em estado final); trigger que bloqueia `UPDATE` de transação em estado final e qualquer `DELETE` |
| `wallet_ledger_entries` | um lançamento por transação e wallet (`UNIQUE`); chave estrangeira composta que obriga o lançamento a ser da wallet da própria transação; `CHECK` da aritmética (`balance_before ± amount = balance_after`); saldos não negativos; trigger que bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; `seq` gerado pelo banco para paginação |
| `inbox_messages` | chave primária `(consumer_name, message_id)` |
| `outbox_messages` | chave primária no `eventId`; índice parcial dos pendentes na ordem de publicação |

Identificadores internos são UUID v7 (ordenáveis por tempo). Identificadores do provedor, rodada e jogo são texto.

## 5. Concorrência

**Unidade de concorrência: a wallet.**

### Estratégia

1. `SELECT … FOR UPDATE` na linha da wallet no início de toda operação que pode mexer no saldo. Operações da mesma wallet são serializadas; wallets diferentes não se bloqueiam. Não existe lock global.
2. O saldo é gravado com `UPDATE … WHERE id = ? AND version = ?`, exigindo uma linha alterada. Sob o lock isso nunca falha; é uma segunda barreira contra atualização perdida.
3. `CHECK (balance >= 0)` e as chaves únicas são a rede de segurança final.
4. `lock_timeout` (padrão 3 s) em toda conexão. Quem não consegue o lock no prazo recebe erro transitório: HTTP 503 com `Retry-After`, ou a mensagem volta para a fila. Nada fica preso indefinidamente.

**Ordem única de lock: wallet primeiro, transação depois**, em todos os caminhos (API, consumer e worker). Nenhuma operação trava duas wallets, então não há ciclo de espera possível.

### Por que lock pessimista

Com wallet disputada ("hot wallet"), o lock pessimista dá resultado determinístico sem laço de retry: a segunda aposta espera a primeira terminar e enxerga o saldo atualizado. Com lock otimista puro, apostas concorrentes na mesma wallet falhariam e precisariam ser repetidas, com custo crescente justamente na wallet mais ativa.

### Corridas que o lock da wallet não cobre

A mesma idempotency key (ou o mesmo par provedor e id externo) enviada ao mesmo tempo para **wallets diferentes** não é serializada pelo lock. Quem perde bate na chave única; a transação SQL é desfeita e uma nova, só de leitura, responde replay ou conflito. Nenhuma das requisições recebe 500.

### Trade-off

Requisições à espera do lock de uma wallet ocupam conexões do pool. Com muitas requisições presas na mesma wallet, operações de outras wallets podem esperar por uma conexão. Mitigações: `DB_POOL_MAX` (padrão 20), `DB_LOCK_TIMEOUT_MS` e o 503 que devolve o controle ao provedor.

## 6. Idempotência

- A fonte da verdade é a **idempotency key**, persistida com chave única. Não há cache em memória.
- `payloadHash` = SHA-256 (hexadecimal) do **JSON canônico** (chaves ordenadas em todos os níveis, sem espaços) destes campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount` (sempre com 2 casas), `money.currency` e `referenceExternalTransactionId` (omitido quando ausente). `playerId` e `walletId` entram em minúsculas. O cabeçalho, a própria key, o `messageId` e demais metadados de transporte ficam fora. O hash é o mesmo para HTTP e SQS.

| Situação | Resultado |
|---|---|
| Mesma key, mesmo hash | Replay: devolve o resultado gravado, com `idempotentReplay: true`, sem aplicar nada |
| Mesma key, hash diferente | Conflito (409) |
| Mesmo provedor e id externo sob outra key | Conflito (409) |

**O replay devolve o estado atual da transação, com o saldo observado quando ela chegou a esse estado.** Uma rejeição continua 422 mesmo que agora haja saldo. Uma transação que respondeu 202 passa a responder 201 depois de aplicada pelo worker.

## 7. Máquina de estados

```
PENDING ─────────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ───► PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são finais. As transições estão encapsuladas em `WagerTransaction`; sair de um estado final é erro de programação, e o banco também bloqueia. `PENDING` só existe dentro da transação SQL que cria a transação.

- **`REJECTED`**: violação de regra de negócio, sempre com `failureCode`. É gravada e auditável; não altera saldo nem gera lançamento.
- **`FAILED`**: erro permanente de infraestrutura ao reprocessar uma pendente. Reservado a erros reconhecidamente permanentes (erro de domínio por dado incoerente, ou violação de dado ou constraint no banco). Qualquer outro erro, inclusive queda de conexão, é tratado como transitório e a transação é tentada de novo: marcar `FAILED` por engano seria irreversível.

## 8. Regras de negócio e códigos de falha

| Operação | Efeito no saldo | Ledger |
|---|---|---|
| `BET` | débito | `DEBIT` |
| `WIN` | crédito | `CREDIT` |
| `LOSS` | nenhum | nenhum |
| `REFUND` | crédito | `CREDIT` |
| `ROLLBACK` | inverso da transação referenciada | invertido |
| `OPENING` (interna) | crédito do saldo inicial | `CREDIT` |

Toda mudança de saldo passa por `Wallet.debit` ou `Wallet.credit`, que devolvem o lançamento do ledger: não há como mover saldo sem gerar o lançamento.

### Taxonomia de `failureCode`

| Código | Significado | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta maior que o saldo | desistir, ou reenviar como nova transação depois de um depósito |
| `REVERSAL_WOULD_OVERDRAW` | a reversão deixaria o saldo negativo (o valor já foi gasto) | intervenção manual |
| `BALANCE_LIMIT_EXCEEDED` | o crédito levaria o saldo acima do limite suportado | intervenção manual |
| `CURRENCY_MISMATCH` | moeda diferente da moeda da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | o player não é dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | a transação referenciada não chegou, ou não foi finalizada, dentro do prazo | reenviar a referência e depois esta, como nova transação |
| `REFERENCE_MISMATCH` | a referência é de outro player, wallet, moeda ou rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | o tipo da referência não pode ser referenciado por esta operação | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência terminou rejeitada ou falha | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente do da referência (não há reversão parcial) | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida | desistir |
| `INFRASTRUCTURE_FAILURE` | falha permanente ao reprocessar (status `FAILED`) | intervenção manual |

## 9. Referências fora de ordem

Uma transação cuja referência ainda não chegou é gravada como `PENDING_REFERENCE` (HTTP 202) e emite `WagerTransactionPendingReference`. Um worker agendado a reprocessa.

- **Referência ausente:** 6 tentativas, com intervalo dobrando a partir de 5 s (5, 10, 20, 40, 80 e 160 s, cerca de 5 minutos). Esgotadas, a transação é rejeitada com `REFERENCE_NOT_FOUND` e o evento de rejeição é publicado. O limite cobre atrasos de entrega de alguns minutos sem deixar pendências indefinidas.
- **Referência existente, mas ainda não finalizada** (por exemplo, `ROLLBACK` de um `REFUND` que espera a `BET`): a transação aguarda **sem gastar tentativas**, para que a cadeia inteira termine processada quando a primeira peça chegar. Essa espera tem prazo total de **15 minutos** desde a criação; sem ele, duas transações que se referenciam em ciclo ficariam pendentes para sempre.
- **Referência finalizada:** aplica ou rejeita na hora, com o código correspondente.

**Consequência para prêmios.** `WIN` e `LOSS` seguem a mesma regra quando trazem referência: um `WIN` cuja `BET` não chega em cerca de 5 minutos é rejeitado com `REFERENCE_NOT_FOUND`, e o crédito não é aplicado. Creditar um prêmio cuja aposta nunca foi debitada seria pagar sem ter cobrado, então a rejeição é a escolha conservadora. Nada se perde em silêncio: a transação fica gravada, o evento `WagerTransactionRejected` é publicado e o provedor recebe 422 com o código ao reenviar ou consultar. Como a idempotency key fica associada à rejeição, a recuperação é do provedor: depois de entregar a `BET`, ele reenvia o prêmio com um novo `externalTransactionId`. Um `WIN` enviado sem referência não passa por essa espera e é creditado na hora.

O worker lê as candidatas vencidas sem lock, trava wallet e transação e **revalida** o estado: se outra instância já tratou a pendente, ele ignora. Erro transitório (lock, conexão) não gasta tentativa e nunca encerra a transação. Um erro desconhecido é repetido até o mesmo prazo de 15 minutos; se persistir, a transação termina `FAILED`, para não ficar pendente para sempre nem atrasar as demais.

## 10. Entradas: HTTP e SQS

A validação é a mesma função para o corpo HTTP e para o `data` da mensagem (`src/interface/wager-transaction.input.ts`): os dois canais aceitam e rejeitam exatamente as mesmas coisas.

### Mapeamento HTTP

| Status | Situação |
|---|---|
| 201 | transação aplicada |
| 202 | aceita, aguardando referência |
| 400 | payload inválido |
| 404 | wallet ou transação inexistente |
| 409 | conflito de idempotência, ou wallet duplicada |
| 422 | rejeitada por regra de negócio (corpo com `failureCode`) |
| 503 | falha transitória, com `Retry-After` |
| 500 | erro não tratado; ou replay de transação `FAILED`, com o corpo da transação |

### Consumer SQS

O registro de inbox `(consumerName, messageId)` é gravado **na mesma transação SQL** do efeito financeiro, e o `ack` (apagar a mensagem) só acontece depois do commit. Se o processo morre entre o commit e o ack, a mensagem é reentregue, o inbox a reconhece e nada é aplicado de novo.

| Resultado | Destino da mensagem |
|---|---|
| Aplicada, rejeitada por regra, pendente de referência, repetida (inbox) | apagada |
| Conflito de idempotência | apagada (erro de negócio: reentregar não muda o resultado) |
| Falha transitória ou erro desconhecido | volta à fila após intervalo crescente (base 2 s, dobrando, teto 300 s); ao atingir 5 recebimentos, o broker a move para a DLQ |
| Erro permanente: mensagem inválida, wallet inexistente, mesmo `messageId` com outro conteúdo | copiada para a DLQ com o atributo `motivo` e apagada na hora, para não travar o grupo FIFO da wallet |

O limite de 5 recebimentos tolera cerca de 30 s de indisponibilidade (2 + 4 + 8 + 16 s) antes da DLQ.

Grupos (wallets) diferentes são processados em paralelo; dentro de um grupo, em ordem. A ordenação e a deduplicação do FIFO são otimização: se o produtor usar outro agrupamento ou a janela de deduplicação expirar, o lock da wallet, a idempotency key e o inbox continuam garantindo o resultado.

## 11. Transactional outbox

Os eventos são gravados em `outbox_messages` na mesma transação SQL da mudança financeira. Nenhum evento existe antes do commit, e nenhum commit fica sem os seus eventos.

O publisher, em cada instância:

1. trava um lote de pendentes com `FOR UPDATE SKIP LOCKED` (publishers concorrentes pegam lotes diferentes, sem esperar um pelo outro);
2. envia cada evento ao SQS com `MessageDeduplicationId = eventId` e `MessageGroupId = walletId`;
3. grava `published_at`, ou reagenda a tentativa, na mesma transação SQL do lote.

Se o processo morre no meio, a transação do lote é desfeita, os eventos continuam pendentes e outra instância os publica. Isso pode repetir um envio: a entrega é **pelo menos uma vez**. Dentro da janela de deduplicação do FIFO (5 minutos) o broker descarta a repetição; fora dela, quem consome deve descartar pelo `eventId` do envelope.

- **Sem limite de tentativas.** Um evento de uma transação confirmada nunca é abandonado. O intervalo dobra de 1 s até o teto de 60 s.
- **Eventos novos primeiro.** A busca ordena por número de tentativas e depois por data: eventos que estão falhando não atrasam os novos.
- **Para na primeira falha do lote**, para não manter uma transação SQL aberta enquanto o broker está fora. O cliente SQS tem prazo que aborta de verdade.
- **Alerta:** a partir de 10 tentativas o evento é registrado em log de aviso; as métricas expõem a quantidade de pendentes e a idade do mais antigo.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected` | transação rejeitada por regra de negócio |
| `WalletBalanceChanged` | somente quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente (uma vez, não a cada tentativa) |

O `aggregateId` de todo evento é a wallet, que é a unidade de ordenação. `data` carrega `MoneyProps`, nunca a instância de `Money`.

## 12. Encerramento e recuperação

Ao receber `SIGTERM` ou `SIGINT`, a aplicação para de aceitar trabalho novo e conclui o que está em andamento, com prazo total de 8 s (abaixo do tempo de parada do Compose, 15 s):

- o servidor HTTP termina as requisições em curso;
- o consumer interrompe o long polling, conclui a mensagem em andamento de cada grupo e devolve à fila as recebidas e ainda não iniciadas;
- os workers terminam o item corrente e param;
- por último, o pool do banco e o cliente SQS são fechados.

Um processo morto sem aviso (`SIGKILL`) não deixa nada inconsistente: transações SQL abertas são desfeitas pelo PostgreSQL, mensagens voltam quando a visibilidade expira e eventos pendentes são publicados por outra instância. Há testes com processos reais para os dois casos.

## 13. Observabilidade

- **Logs** em JSON (pino), com `correlationId` em toda linha de uma requisição, mensagem ou ciclo de worker, e `pid` da instância. As linhas de processamento trazem `transactionId`, `walletId`, `providerId` e, na fila, `messageId`. Valores monetários, payloads e detalhes de erro do banco **não** são logados; um teste verifica isso.
- **Correlação:** o cabeçalho `x-correlation-id` é aceito e devolvido; o valor vai para os eventos gerados. Mensagens da fila geram `causationId = messageId` nos eventos.
- **Métricas** em `GET /metrics`, no formato de texto do Prometheus:

| Métrica | Tipo | Conteúdo |
|---|---|---|
| `wager_transactions_total{kind,status,source}` | counter | transações por status |
| `wager_duplicates_total{type}` | counter | replays, conflitos de idempotência, mensagens repetidas |
| `wager_retries_total{component}` | counter | novas tentativas (consumer, outbox, pendentes) |
| `wager_dlq_messages_total{reason}` | counter | mensagens enviadas à DLQ por esta instância |
| `wager_dlq_depth` | gauge | mensagens paradas na DLQ |
| `wager_lock_conflicts_total{reason}` | counter | operações interrompidas por lock ou conexão |
| `wager_outbox_pending`, `wager_outbox_lag_seconds` | gauge | pendentes da outbox e idade do mais antigo |
| `wager_processing_duration_seconds{source}` | histogram | latência de processamento |
| `wallet_reconciliation_divergences_total` | counter | reconciliações divergentes |

- **Health checks:** `/health/live` não consulta dependências; `/health/ready` verifica PostgreSQL e SQS e responde 503 dizendo qual está fora. Nenhum dos dois exige autenticação.

`wager_transactions_total` conta o status de cada transação na entrada (`source` http, sqs ou internal) e, para as que ficaram pendentes, de novo quando chegam ao estado final (`source="worker"`). "Mensagens em DLQ" aparece de duas formas: o contador cobre os envios feitos pela aplicação (erros permanentes, com o motivo) e o gauge `wager_dlq_depth` mostra o total parado na fila, incluindo o que o broker moveu por excesso de tentativas.

As métricas são por instância; quem coleta soma as séries das réplicas. O registro de métricas é próprio, sem biblioteca, por serem poucos contadores e um histograma.

## 14. Extrato e reconciliação

- **Extrato:** paginação por cursor opaco sobre `seq`, a posição de gravação do lançamento. Como o ledger só recebe inclusões e as inclusões de uma wallet são serializadas pelo lock, uma página nunca repete nem pula lançamentos, mesmo com gravações entre as páginas.
- **Reconciliação:** trava a wallet, soma créditos e débitos do ledger no banco e compara com o saldo guardado. Uma divergência é sinalizada na resposta (`consistent: false`), registrada em log de erro e contada em métrica. **Nunca é corrigida automaticamente.** O lock fica retido durante a soma: é a forma mais simples de ler saldo e ledger no mesmo instante, ao custo de segurar as transações da wallet enquanto a reconciliação roda.

## 15. Autenticação

**Não implementada.** O enunciado aceita essa escolha e não atribui pontos a ela; o tempo foi dedicado a correção financeira, concorrência e idempotência.

**Ponto de extensão:** `AuthGuard` (`src/interface/http/auth.guard.ts`), aplicado aos controllers de wallets e de transações e hoje sem efeito. Os health checks e `/metrics` ficam fora dele.

**Desenho que seria adotado:** um Identity Provider externo (Keycloak) com OAuth 2.0 *client credentials*, um cliente por provedor de jogos.

1. O provedor obtém um token de acesso no Keycloak.
2. O `AuthGuard` valida assinatura, emissor, audiência e expiração do JWT com as chaves públicas do IdP (JWKS, em cache).
3. O token carrega o identificador do provedor em uma *claim*. O guard compara essa identidade com o `providerId` do payload e com o `:providerId` da rota; divergência é 403.
4. Criação de wallet e reconciliação exigem um papel administrativo distinto.

Não haveria tabela própria de usuários nem senha na aplicação. Mensagens da fila são um canal interno confiável, mas o `providerId` que elas carregam passa pelas mesmas validações de domínio.

## 16. Interpretações do enunciado

Pontos em que o enunciado é ambíguo ou silencioso, e o que foi adotado.

| # | Ponto | Interpretação |
|---|---|---|
| 1 | "Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação" | **Uma única reversão por transação, de qualquer tipo.** Lida ao pé da letra, a regra permitiria `REFUND` e `ROLLBACK` da mesma `BET`, creditando duas vezes. Consequência: depois de `ROLLBACK` de um `REFUND`, a `BET` não pode ser reembolsada de novo |
| 2 | `WIN` "pode referenciar" a `BET` | Referência opcional. Se vier, é validada (provedor, player, wallet, moeda, rodada, e só `BET`); se a `BET` ainda não chegou, o `WIN` fica pendente |
| 3 | Referência em `BET` e `LOSS` | `BET` não aceita referência (payload inválido). `LOSS` aceita referência opcional a uma `BET`, com o mesmo tratamento do `WIN` |
| 4 | Wallet inexistente | 404 sem gravar a transação (não há wallet para travar). Na fila: erro permanente, DLQ |
| 5 | Player ou moeda divergente da wallet | Transação `REJECTED` gravada e auditável, com código próprio |
| 6 | "Saldo observado naquele momento" no replay | Gravado na própria transação, inclusive nas rejeitadas, com a sua moeda |
| 7 | Versão da wallet | Nasce em 1, mesmo com saldo inicial; aumenta a cada mudança de saldo |
| 8 | Valor zero | Só `LOSS` aceita `0.00`. Nas demais é payload inválido |
| 9 | Formato do valor | Exatamente 2 casas, na entrada e na saída. O enunciado lista "mais de 2 casas" como inválido e não cita "menos de 2"; foi adotada a leitura estrita de "escala fixa de 2 casas" |
| 10 | Referência encontrada, mas não finalizada | A dependente aguarda. Divergência de contexto só é avaliada quando a referência chega a um estado final |
| 11 | Transação `OPENING` | Identificadores sintéticos: provedor `internal`, id externo igual ao id da wallet, key `opening:{walletId}`. O provedor `internal` é reservado. Emite eventos como qualquer transação |
| 12 | Mesmo provedor e id externo sob outra idempotency key | Conflito 409 |
| 13 | Ordem dos eventos publicados | Não garantida entre publishers concorrentes; quem consome usa `walletVersion` e `eventId` |
| 14 | Crédito que estoura o valor máximo | Rejeição de negócio (`BALANCE_LIMIT_EXCEEDED`) |
| 15 | Quando uma transação vira `FAILED` | Só ao reprocessar uma pendente: por erro permanente, ou por erro desconhecido que persiste além do prazo de espera; não gera evento de integração (o enunciado não define um) |
| 16 | Destino dos eventos | Fila `wager-events.fifo` no mesmo SQS; nenhum consumidor foi escrito |
| 17 | "Mesma resposta" no replay | O replay devolve o **estado atual** da transação: uma que respondeu 202 passa a responder 201 (ou 422) depois de resolvida pelo worker. O resultado de uma transação finalizada nunca muda |
| 18 | Formato de `playerId` e `walletId` | UUID, como nos exemplos do enunciado; outro formato é payload inválido |

## 17. Decisões e trade-offs

| Decisão | Motivo | Custo aceito |
|---|---|---|
| **Uma aplicação só; toda instância roda API, consumer e workers** | Prazo de entrega e complexidade do projeto: um único artefato para construir, testar e operar | Não é possível escalar só a API ou só o consumer. Caminho de evolução: as variáveis `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED` e `PENDING_WORKER_ENABLED` já permitem subir instâncias com papéis diferentes a partir da mesma imagem |
| Lock pessimista na wallet | Determinístico em wallet disputada, sem retry | Requisições em espera ocupam conexões do pool |
| MiniStack em vez de LocalStack | As versões recentes do LocalStack exigem token de autenticação, o que obrigaria quem avalia a criar uma conta | Emulador menos difundido; a versão da imagem está fixada |
| Sem balanceador no Compose | Menos uma peça; cada réplica tem a sua porta | O cliente escolhe a réplica |
| Validação de entrada manual | Poucas regras, a mesma função para HTTP e SQS, sem dependência extra | Sem geração automática de documentação da API |
| Registro de métricas próprio | Poucas métricas; evita uma dependência | Sem os recursos de uma biblioteca completa |
| Injeção de falha por variável de ambiente (`FAULT_EXIT_BEFORE_ACK`) | Torna determinístico o teste "morto depois do commit e antes do ack" com processos reais | Código de teste no caminho de produção; a variável é recusada com `NODE_ENV=production` |
| Opcionais fora (teste de carga, partidas dobradas, OpenTelemetry) | Prazo | Não há números de throughput medidos |

## 18. Limitações conhecidas

- **Hot wallet e pool:** muitas requisições presas no lock da mesma wallet podem atrasar outras wallets, por ocuparem conexões (seção 5).
- **Entrega de eventos pelo menos uma vez**, sem garantia de ordem entre publishers; quem consome deve ser idempotente por `eventId`.
- **Mensagens atrás de uma falha transitória** no mesmo grupo FIFO também somam recebimentos. Uma indisponibilidade longa do banco pode levar à DLQ mensagens válidas ainda não tentadas; elas chegam sem o atributo `motivo` e devem ser reenviadas à fila principal.
- **Relógios entre instâncias:** os agendamentos de nova tentativa são comparados com o relógio de quem lê. Relógios dessincronizados adiantam ou atrasam uma tentativa pela diferença entre eles; a correção não é afetada.
- **Worker de pendentes sem `SKIP LOCKED`:** todas as instâncias leem as mesmas candidatas e disputam o lock da wallet. Mais instâncias aumentam a disponibilidade do reprocessamento, não a vazão.
- **Outbox durante queda longa do broker:** o índice dos pendentes não cobre o filtro por data da próxima tentativa; o custo de cada ciclo cresce com o total de pendentes.
- **Imutabilidade por trigger:** o usuário do banco usado pela aplicação é dono das tabelas e poderia desabilitar os triggers. Em produção, a aplicação usaria um papel sem esse privilégio.
- **Requisições com JSON malformado ou corpo grande demais** são respondidas pelo parser antes do middleware de correlação e saem sem `x-correlation-id`.
- **`FAILED` não gera evento:** quem acompanha uma transação pendente só pelos eventos não recebe esse desfecho; ele aparece na consulta da transação e no log.
- **Métricas por instância**, sem agregação entre réplicas.
- **Sem autenticação** (seção 15) e sem limite de taxa por provedor.
- **Sem teste de carga:** os testes de concorrência provam correção, não throughput.
