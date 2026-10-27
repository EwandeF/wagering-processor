# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, com entrega **at-least-once**, várias instâncias concorrentes e o banco como guardião das invariantes.

**Stack:** Bun 1.4 · TypeScript estrito · NestJS 12 · PostgreSQL 16 · MikroORM 7 · AWS SQS (LocalStack) · Docker Compose.

As decisões de desenho, a taxonomia de falhas, o algoritmo de idempotência e as limitações conhecidas estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Garantias

- Dinheiro nunca passa por `number`: é string decimal com 2 casas na API, `decimal.js` no domínio e `NUMERIC(19,2)` no banco.
- Saldo nunca negativo, ledger imutável e unicidade de idempotência são **constraints e gatilhos do PostgreSQL**, não só código.
- Uma transação financeira, o lançamento do ledger, o saldo, a inbox e os eventos da outbox são gravados **na mesma transação SQL**.
- Funciona com várias instâncias: nenhum estado em memória garante idempotência ou ordem, só o banco.

## Requisitos

- Docker com Compose v2
- Bun 1.4.x (`curl -fsSL https://bun.sh/install | bash`)

## Como rodar

```bash
bun install

# 1) Só a infraestrutura: PostgreSQL e LocalStack (cria as filas FIFO e a DLQ)
bun run infra:up
bun run migrate:up

# 2) A aplicação, numa instância só
bun run start                  # http://localhost:3000

# 3) Ou a pilha completa: migrations + 3 instâncias em containers (portas 3001 a 3003)
bun run stack:up
bun run stack:down             # para as 3 instâncias
```

Os dados persistem entre execuções. Para recomeçar do zero: `docker compose --profile app down -v`.

> **Atenção:** as instâncias em containers também consomem a fila e publicam a outbox. Pare-as (`bun run stack:down`) antes de rodar a suíte de testes, senão elas competem pelos mesmos eventos e as contagens dos testes deixam de bater.

## Scripts

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a API e os workers (outbox, fila, referências pendentes) |
| `bun run test` | Suíte completa (precisa de `infra:up` e `migrate:up`) |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run migrate:up` / `migrate:down` / `migrate:pending` | Migrations versionadas e reversíveis |
| `bun run migrate:roundtrip` | Prova a reversibilidade: sobe, desfaz tudo e sobe de novo num banco descartável, comparando o schema |
| `bun run infra:up` | PostgreSQL + LocalStack |
| `bun run stack:up` / `stack:down` | 3 instâncias em containers |
| `bun run stack:failover` | Derruba duas instâncias no meio do processamento e confere o resultado final |

## Configuração

Tudo por variáveis de ambiente, com padrões que funcionam com `infra:up`:

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgresql://wager:wager@localhost:5432/wager` | Conexão com o PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS (LocalStack) |
| `PORT` | `3000` | Porta HTTP |
| `WORKERS_ENABLED` | `true` | `false` sobe só a API, sem consumir fila nem publicar eventos |
| `WAGER_QUEUE_URL` / `WAGER_DLQ_URL` / `EVENTS_QUEUE_URL` | `wager-transactions.fifo` / `-dlq.fifo` / `wager-events.fifo` | Filas de entrada, DLQ e eventos de saída |
| `OUTBOX_POLL_MS` | `500` | Intervalo do publisher quando não há eventos |
| `REFERENCE_POLL_MS` | `2000` | Intervalo do worker de referências pendentes |
| `CONSUMER_MAX_RECEIVE_COUNT` | `5` | Recebimentos antes de a mensagem ir para a DLQ |

## API HTTP

Todo erro sai no mesmo formato: `{ "error": { "code": "...", "message": "..." } }`.

| Situação | Status |
|---|---|
| Processada (nova ou replay) | `200` |
| Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | `202` |
| Rejeitada por regra de negócio | `422` |
| Payload inválido, header ausente, cursor ou `limit` inválidos | `400` |
| Wallet ou transação inexistente | `404` |
| Conflito: wallet duplicada, ou idempotência com payload diferente | `409` |
| Falha transitória (banco fora, conflito de concorrência) | `503` com `Retry-After` |
| Erro interno | `500`, sem detalhes na resposta |

Exemplos (`playerId` e `walletId` são UUIDs):

```bash
# Criar wallet: gera a transação interna OPENING e o lançamento de crédito na mesma transação SQL
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Submeter uma transação (o header Idempotency-Key é obrigatório)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Uma rejeição (`422`) traz o `failureCode` e o que o provedor deve fazer (`providerAction`: `RETRY_LATER`, `FIX_PAYLOAD`, `GIVE_UP` ou `CONTACT_SUPPORT`).

| Método e rota | Para quê |
|---|---|
| `POST /wallets` | Cria a wallet (conflito `409` se o jogador já tem uma na moeda) |
| `GET /wallets/:walletId` | Saldo e `version` |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Ledger paginado; o cursor é opaco e estável |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo guardado com a soma do ledger; nunca corrige em silêncio |
| `POST /wagering/transactions` | Submete `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness; readiness (PostgreSQL e SQS, `503` diz qual caiu) |
| `GET /metrics` | Métricas no formato Prometheus |

O header opcional `X-Correlation-Id` é devolvido na resposta e acompanha a operação até os logs e os eventos. Valores com caracteres fora de `A-Za-z0-9._:-` são substituídos por um UUID.

## Mensageria

**Entrada** (`wager-transactions.fifo`, DLQ em `wager-transactions-dlq.fifo`): mensagens `WagerTransactionRequested`, tratadas pelo mesmo caso de uso da API HTTP, deduplicadas por `(consumerName, messageId)` na inbox, e confirmadas só depois do commit. Erro de negócio terminal é confirmado, erro transitório volta com backoff e, esgotado o limite, vai para a DLQ; erro permanente (JSON inválido, valor inválido, wallet inexistente, `messageId` repetido com outro conteúdo) vai direto para a DLQ.

**Saída** (`wager-events.fifo`), publicada pela outbox transacional: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`. O `aggregateId` é sempre o `walletId`, usado como `MessageGroupId`. A entrega é at-least-once: o `eventId` é o que permite ao consumidor descartar repetições.

## Observabilidade

- **Logs** em JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` no nível principal. Nunca levam valores monetários nem payloads.
- **Métricas** (`/metrics`): transações por status e tipo, duplicatas detectadas, latência de processamento, espera pelo lock da wallet, conflitos de concorrência, retries e mensagens na DLQ, publicações e falhas da outbox, **outbox lag** (idade do evento pendente mais antigo) e pendentes, resultados do worker de referências e reconciliações com divergência.
- **Health:** `live` não depende de nada externo; `ready` testa PostgreSQL e SQS com timeout de 2 s.

## Testes

369 testes, todos passando. Os de integração e de concorrência usam **PostgreSQL e SQS reais** (nenhum mock substitui o banco ou a fila).

```bash
bun run infra:up && bun run migrate:up    # uma vez
bun run test                              # a suíte leva uns 2 minutos
```

| Categoria | Testes | O que prova |
|---|---:|---|
| Unitários, sem banco | 160 | `Money` (escala, entradas inválidas, `0.10 + 0.20`), invariantes da `Wallet`, transições de `WagerTransaction`, política de reversão, eventos, `OutboxMessage` e `InboxMessage` (backoff), logger JSON, laço de polling |
| Persistência e schema | 25 | **Cada garantia do schema é testada tentando violá-la direto no banco**, sem passar pela aplicação: saldo negativo, ledger imutável (`UPDATE`, `DELETE` e `TRUNCATE`), lançamento que não fecha a conta, unicidade de idempotência por provedor, reversão única por referência, consistência de estado da transação, inbox e outbox. Cada violação tem um teste de controle mostrando que o SQL válido seria aceito. Mais a ida e volta pelo banco e os gatilhos das transações terminais |
| Casos de uso no PostgreSQL | 56 | BET, WIN, LOSS, REFUND, ROLLBACK, idempotência e conflito de payload, inbox, atomicidade (falha no fim desfaz transação, ledger, saldo, inbox e outbox juntos), referências fora de ordem |
| API HTTP | 87 | Status e formato de erro, wallets, transações, ledger paginado sob escrita concorrente, reconciliação, correlação e métricas |
| Mensageria com SQS real | 22 | Publisher com vários concorrentes, retry, DLQ, worker morto entre o commit e o ack, shutdown |
| Concorrência | 6 | Duas apostas de 80 com saldo 100 (uma processada, uma `INSUFFICIENT_FUNDS`, saldo 20.00, um débito), a mesma aposta 50 vezes em paralelo, wallet quente com 150 apostas, wallets distintas em paralelo |
| Ponta a ponta e multiprocesso | 13 | App completo com workers; **3 processos do sistema operacional** de verdade; `kill -9` no meio do consumo; reinício do serviço com reconciliação ao final |

Todo teste de saldo termina com a invariante do case: `saldo da wallet == saldo reconstruído pelo ledger`.

Além da suíte, dois scripts exercitam a pilha em Docker:

- `bun run stack:failover` sobe 800 apostas na fila, derruba uma instância com `docker stop` e outra com `docker kill` no meio do processamento, e confere que sobraram exatamente 800 apostas, wallets em `50.00`, todos os eventos publicados e a DLQ vazia.
- `bun run migrate:roundtrip` prova que as 9 migrations são reversíveis.

> O ledger é imutável por gatilho, então os testes não apagam o que criam: o banco de desenvolvimento só cresce. Para recomeçar limpo: `docker compose --profile app down -v`.

## Estrutura

```
src/domain/           Regras puras: Money, Wallet, WagerTransaction, ledger, eventos, políticas
src/application/      Casos de uso e portas (OpenWallet, SubmitWagerTransaction, publisher, workers)
src/infrastructure/   PostgreSQL (MikroORM, migrations), SQS, métricas e logs
src/interfaces/http/  Controllers, validação de entrada, mapeamento de erros
src/workers/          Laços de fundo: outbox, consumidor da fila, referências pendentes
scripts/              Failover entre containers e prova de reversibilidade das migrations
test/                 Unidade, integração, concorrência, ponta a ponta e multiprocesso
```
