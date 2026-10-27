# Arquitetura e decisões

Este documento explica **por que** o sistema é como é. Como rodar, a API e os testes estão no [README](README.md). Cada decisão aponta o teste que a prova, e o que **não** está provado aparece como limitação (seção final), nunca como garantia.

## 1. Princípio

**O banco é a autoridade; a mensageria é transporte.** SQS FIFO, ordenação e deduplicação do broker são otimizações. Toda invariante financeira (saldo não negativo, ledger imutável, idempotência, reversão única) é aplicada por constraint ou gatilho do PostgreSQL, e o código de aplicação apenas a respeita. Nenhum estado em memória garante algo: por isso o sistema é correto com qualquer número de instâncias.

```
HTTP (NestJS)           SQS: wager-transactions.fifo
      \                        /
       v                      v
        SubmitWagerTransaction   <- o mesmo caso de uso nas duas entradas
                  |
    UMA transação SQL no PostgreSQL:
    lock da wallet -> inbox -> transação -> ledger -> saldo -> outbox
                  |
   Publisher (FOR UPDATE SKIP LOCKED) --> SQS: wager-events.fifo
   Worker de referências pendentes (mesma regra de reversão, mesma transação)
```

| Camada | Pasta | Regra de dependência |
|---|---|---|
| Domínio | `src/domain` | TypeScript puro. Sem NestJS, sem ORM, sem SQS |
| Aplicação | `src/application` | Casos de uso e **portas** (interfaces). Só conhece o domínio |
| Infraestrutura | `src/infrastructure` | Implementa as portas: MikroORM, SQS, métricas, logs |
| Interfaces | `src/interfaces/http` | Controllers, validação de entrada, mapeamento de erros |
| Workers | `src/workers` | Laços de fundo: outbox, fila de entrada, referências pendentes |

## 2. Justificativas exigidas pelo case

### ORM: MikroORM 7

Escolhido por ser o preferencial do case e por oferecer o que a concorrência exige: `EntityManager.transactional()`, `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`, usado pelo publisher da outbox).

**Modelos de persistência separados do domínio.** As classes do domínio (`Wallet`, `Money`, `WagerTransaction`...) têm construtor privado e fábricas estáticas, e não dependem de nenhuma biblioteca. O MikroORM mapeia **registros** simples (`EntitySchema`, em `src/infrastructure/persistence/schemas.ts`), e *mappers* convertem nos dois sentidos, usando `rehydrate` na leitura (que não revalida regras, como o case descreve). Custo: um arquivo de mapeamento a mais. Ganho: o domínio é testável sem banco (160 testes unitários) e nenhuma decorator do ORM vaza para ele.

### Mapeamento do `Money`

| Camada | Representação |
|---|---|
| API e eventos | `{ "amount": "25.00", "currency": "BRL" }`, sempre string |
| Domínio | `Money` imutável sobre `decimal.js` (precisão 40) |
| Banco | `amount NUMERIC(19,2)` + `currency CHAR(3)`, em colunas separadas |
| Registro de persistência | `amount` como `string`, nunca `number` |

O valor **nunca passa por `number`** em nenhum ponto do caminho. O formato de entrada é rígido de propósito: exatamente 2 casas decimais, sem sinal, sem zeros à esquerda, até 17 dígitos inteiros (o que cabe em `NUMERIC(19,2)`). Isso rejeita `NaN`, `Infinity`, notação científica (`1e3`), vazio, `25.5`, `25.001` e negativos, e dá **uma única forma escrita por valor**, o que torna o hash de idempotência estável. Valores negativos só existem como resultado interno de conta (`subtract`, `negate`); a `Wallet` impede que virem saldo. Testes: `money.test.ts` (inclui `0.10 + 0.20 = 0.30` exato) e `persistence.test.ts` (o saldo volta do banco como string).

### Estratégia transacional

Cada execução abre um fork do `EntityManager` e uma transação (`em.fork().transactional(...)`), de modo que não existe Identity Map nem conexão compartilhados entre requisições. Os repositórios são **portas** (`WagerUnitOfWork`, em `src/application/ports.ts`), e o adaptador do MikroORM está em `src/infrastructure/persistence/mikro-wager-unit-of-work.ts`.

**Escolha explícita: não usamos o rastreamento de mudanças (flush) do Unit of Work.** As ligações entre tabelas são colunas simples (`wallet_id`, `transaction_id`), não relações do ORM, e usamos `em.insert` e `em.nativeUpdate`, que executam na hora e na ordem em que o caso de uso os chama. Motivo: o fluxo financeiro precisa de ordem previsível (transação, ledger, saldo, outbox) e de um `UPDATE` do saldo guardado por versão, e um `flush` automático esconderia essa ordem. Custo: perdemos a conveniência do rastreamento de mudanças; ganho: cada comando SQL do fluxo é visível no código.

### Migrations

Nove migrations em SQL escrito à mão (`src/infrastructure/database/migrations`), versionadas e **reversíveis**. Não usamos o gerador automático porque as garantias do schema são constraints parciais e gatilhos, que ele não cria (`snapshot: false`). `bun run migrate:roundtrip` prova a reversibilidade num banco descartável: sobe as 9, desfaz as 9 (sobra só a tabela de controle do MikroORM e nenhuma função) e sobe de novo, comparando o schema antes e depois (idêntico, 454 linhas).

## 3. Concorrência

**A unidade de concorrência é a `walletId`.** Estratégia: **lock pessimista de linha** (`SELECT ... FOR UPDATE` na wallet), mais duas defesas atrás dele.

1. **Lock pessimista por wallet.** Toda operação que muda saldo trava a linha da wallet no início da transação e só a solta no commit. Wallets diferentes nunca se bloqueiam (não há lock global), e operações da mesma wallet são serializadas.
2. **`UPDATE` guardado por versão.** O saldo é gravado com `where version = <a que li>`. Se o lock falhar por qualquer motivo, o `UPDATE` afeta 0 linhas e o caso de uso lança `ConcurrentModificationError` (vira `503` com `Retry-After`), em vez de gravar errado. A `version` começa em 1 e só sobe quando o saldo muda (uma `LOSS` não a altera).
3. **`CHECK (balance >= 0)` no banco.** A última barreira: nem um bug consegue gravar saldo negativo.

**Por que pessimista e não otimista.** Numa "wallet quente" (muitas apostas na mesma wallet), o controle otimista faria a maioria das tentativas falhar e repetir, e o custo cresce com a contenção. Com o lock, a fila de espera é no banco, sem repetição na aplicação. O custo é o tempo de espera pelo lock, que medimos em `wager_wallet_lock_wait_seconds`.

**Sem deadlock por ordem de aquisição.** Todos os caminhos (HTTP, consumidor da fila, worker de referências) travam **a wallet primeiro**. O publisher da outbox trava só linhas da outbox e nunca uma wallet, então não existe ciclo.

### Corrida, defesa e teste

| Corrida | Defesa | Teste |
|---|---|---|
| Duas apostas de 80 disputando saldo 100 | Lock da wallet + `CHECK` | `concurrency.test.ts`, `multiprocess.test.ts` (em 3 processos) |
| A mesma aposta enviada 50 vezes em paralelo | Lock + índice único de idempotência | `concurrency.test.ts`, `multiprocess.test.ts` |
| 10 criações simultâneas da mesma wallet | Índice único `(player_id, currency)`, sem lock | `http-wallets.test.ts` |
| 20 REFUNDs simultâneos da mesma BET | Lock + checagem de reversão + índice único parcial | `reversal.test.ts` |
| Dois workers reprocessando a mesma pendente | Lock + **releitura com `refresh`** depois do lock | `pending-reference-worker.test.ts` |
| Vários publishers sobre a mesma outbox | `FOR UPDATE SKIP LOCKED` | `outbox-relay.test.ts` |
| A mesma mensagem entregue 30 vezes ao mesmo tempo | Inbox, checada com a wallet travada | `inbox.test.ts` |
| Processo morto no meio (`kill -9`) | Transação atômica: o que não commitou não existe | `multiprocess.test.ts`, `bun run stack:failover` |

**Um defeito que os testes acharam.** No worker de referências, a transação era lida antes do lock e de novo depois. A segunda leitura voltava do Identity Map, sem ir ao banco, e um worker que esperou o lock via o estado antigo (ainda pendente) e rejeitava uma reversão que o outro já tinha aplicado. O saldo não ficava errado, mas a auditoria sim. A correção foi `refresh: true` na releitura, e o gatilho `wager_tx_guard` (migration 8) agora impede por si só que uma transação terminal seja alterada.

## 4. Idempotência

Toda a deduplicação é **persistente**: não há cache em memória nem estado local de instância.

- O header `Idempotency-Key` é **obrigatório** e é a fonte da verdade. Sem ele, `400`.
- Na fila, a chave vem no campo `idempotencyKey` da mensagem.
- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` no banco: dois pedidos nunca criam duas transações, mesmo que a aplicação falhe em detectar o replay.

### Algoritmo do `payloadHash`

SHA-256 (hex) do **JSON canônico** do subconjunto de campos de negócio (`src/application/payload-hash.ts`). O JSON canônico tem chaves em ordem alfabética, sem espaços, e descarta valores `undefined`. Os campos que entram são:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`{amount, currency}`) e `referenceExternalTransactionId`.

**Ficam de fora**: o header `Idempotency-Key`, o `X-Correlation-Id` e qualquer metadado de transporte. Por isso o mesmo pedido reenviado com outro correlation id continua sendo replay (`correlation.test.ts`). Na fila, o hash cobre `{ type, data }` da mensagem, sem o `messageId` nem o `occurredAt`, e é gravado na inbox para detectar um `messageId` repetido com conteúdo diferente.

### Decisão do pedido repetido

Tudo é decidido **dentro da transação, com a wallet já travada**, para que dois pedidos simultâneos sejam serializados e o segundo enxergue o primeiro:

| Situação | Resultado |
|---|---|
| Mesma chave, mesmo id externo, mesmo hash | **Replay**: devolve o resultado original, `idempotentReplay: true`, sem efeito nem eventos novos |
| Mesma chave **ou** mesmo id externo, hash diferente | **Conflito**: `409 IDEMPOTENCY_CONFLICT` |
| Chave nova e id externo novo | Pedido novo |

Um replay devolve o **saldo observado na época** do processamento original (a coluna `observed_balance`), não o saldo atual da wallet. O case exige isso ("o saldo observado naquele momento"), e é por isso que a coluna existe: numa `LOSS` ou numa rejeição não há lançamento no ledger de onde tirar esse número. Teste: `submit.test.ts` ("replay devolve o resultado original com o saldo observado na época").

**Rede de segurança contra corrida entre chaves diferentes.** Se duas requisições batem na mesma chave única sem que o lock da wallet as serialize (por exemplo, a mesma chave em wallets diferentes), o `INSERT` do perdedor falha com violação de unicidade. O caso de uso trata isso repetindo **uma vez** a transação inteira, que agora cai no caminho de replay ou de conflito (e conta em `wager_lock_conflicts_total{type="duplicate_key_retry"}`).

### Duas camadas: inbox e idempotência financeira

A inbox (`UNIQUE (consumer_name, message_id)`) deduplica **mensagens**; a idempotência por chave deduplica **operações**. São independentes: a mesma operação que chegue primeiro por HTTP e depois pela fila com `messageId` diferente vira replay, e a inbox é registrada mesmo assim (`inbox.test.ts`). A inbox é gravada na **mesma transação** do efeito, então uma falha desfaz os dois e a reentrega processa normalmente.

## 5. Máquina de estados da transação

```
                 +--> PROCESSED   (aplicada)              terminal
   PENDING ------+--> REJECTED    (regra de negócio)      terminal
      |          +--> FAILED      (erro de infraestrutura) terminal   <- ver limitações
      v
 PENDING_REFERENCE --> PROCESSED | REJECTED | FAILED
```

- `PROCESSED`, `REJECTED` e `FAILED` são **terminais**. Tentar transicionar uma transação terminal lança `InvalidTransactionStateError`: é erro de programação, não caminho de negócio.
- Em `PENDING_REFERENCE` a transação pode ser **reagendada** (`retryReference`, que soma uma tentativa e marca a próxima checagem), mas nunca volta a `PENDING`.
- Na prática, a transação só passa por `PENDING` dentro de uma única transação SQL: ela nasce, é decidida e é gravada **já no estado final** (ou em `PENDING_REFERENCE`).
- **Imposto pelo banco.** O gatilho `wager_tx_guard` recusa qualquer alteração de uma transação terminal, a volta a `PENDING`, a mudança dos campos de identidade, e `DELETE` e `TRUNCATE`. Constraints de consistência exigem `failure_code` em `REJECTED` e `FAILED`, `processed_at` em `PROCESSED` e o saldo observado fora de `PENDING`. Testes: `transaction-guard.test.ts`, `schema-constraints.test.ts`, `wager-transaction.test.ts`.

## 6. Interpretações adotadas

O case pede que qualquer interpretação adicional seja documentada. Estas são as nossas.

**6.1. Cada transação só pode ser revertida UMA vez, de qualquer tipo.** *(Esta muda o texto literal.)* O case diz que uma referência "não pode ser revertida duas vezes pelo mesmo tipo de operação". Lido ao pé da letra, uma `BET` poderia ser revertida por um `REFUND` **e** depois por um `ROLLBACK`, e as duas devolveriam o dinheiro: **crédito duplicado**, que o próprio case lista como invariante global violável e falha eliminatória. Adotamos a leitura mais segura: o índice único parcial `wager_tx_one_reversal_per_reference` impede qualquer segunda reversão processada da mesma referência. Uma reversão **rejeitada** não ocupa a vaga. Testes: `reversal.test.ts` ("REFUND e depois ROLLBACK da mesma BET") e `schema-constraints.test.ts`. Se a leitura literal for a desejada, é a troca de um índice (uma migration).

**6.2. Rejeições são persistidas e auditáveis.** Uma `BET` sem saldo vira uma transação `REJECTED` com `failure_code`, saldo observado e evento `WagerTransactionRejected`, e não uma exceção sem rastro. Ela não gera lançamento no ledger nem muda o saldo.

**6.3. Reversão que ficaria negativa tem código próprio.** `REVERSAL_WOULD_OVERDRAW` (reversão) é distinto de `INSUFFICIENT_FUNDS` (aposta), como o case pede, porque são situações operacionalmente diferentes.

**6.4. Referência em estado não aplicado.** Se a referência está `REJECTED` ou `FAILED`, a reversão é rejeitada (`REFERENCE_NOT_PROCESSED`): não há o que reverter. Se está `PENDING` ou `PENDING_REFERENCE`, a reversão **espera** (também vira `PENDING_REFERENCE`).

**6.5. Ordem das validações de uma reversão.** Pertencimento (provedor, jogador, wallet, moeda, rodada), depois tipo da referência, estado, valor e, por último, reversão anterior. Um erro de pertencimento vence os demais (`reversal-policy.test.ts`).

**6.6. `LOSS` aceita valor zero**, porque não move saldo; os demais tipos exigem valor positivo. `LOSS` não gera lançamento, mas gera `WagerTransactionProcessed`.

**6.7. Jogador diferente do dono da wallet** vira rejeição `PLAYER_WALLET_MISMATCH`, e moeda diferente da wallet, `CURRENCY_MISMATCH`. Em ambos os casos o saldo devolvido é o da wallet, na moeda da wallet.

## 7. Taxonomia de falhas

Todo `REJECTED` e `FAILED` carrega um `failureCode` estável. A API devolve também o que o provedor deve fazer (`providerAction`), para decidir sem interpretar mensagem. Fonte: `src/domain/failure-code.ts`.

| `failureCode` | Situação | `providerAction` |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Aposta maior que o saldo | `RETRY_LATER` |
| `REVERSAL_WOULD_OVERDRAW` | A reversão deixaria o saldo negativo | `RETRY_LATER` |
| `REFERENCE_NOT_FOUND` | A referência nunca chegou (esgotou as checagens) | `FIX_PAYLOAD` |
| `REFERENCE_MISMATCH` | Provedor, jogador, wallet, moeda ou rodada diferentes da referência | `FIX_PAYLOAD` |
| `INVALID_REFERENCE_KIND` | `REFUND` de algo que não é `BET`, ou `ROLLBACK` de algo fora de `BET`, `WIN` e `REFUND` | `FIX_PAYLOAD` |
| `REVERSAL_AMOUNT_MISMATCH` | Valor diferente do da referência (reversão parcial está fora de escopo) | `FIX_PAYLOAD` |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | `FIX_PAYLOAD` |
| `PLAYER_WALLET_MISMATCH` | O jogador não é o dono da wallet | `FIX_PAYLOAD` |
| `REFERENCE_NOT_PROCESSED` | A referência foi rejeitada ou falhou | `GIVE_UP` |
| `ALREADY_REVERSED` | A referência já foi revertida | `GIVE_UP` |
| `PROCESSING_FAILED` | Erro permanente de infraestrutura | `CONTACT_SUPPORT` |

O significado de `providerAction`: `RETRY_LATER` (a situação pode mudar; reenvie como nova transação), `FIX_PAYLOAD` (corrija antes de reenviar), `GIVE_UP` (não adianta reenviar) e `CONTACT_SUPPORT` (problema do nosso lado). O `Record<FailureCode, ProviderAction>` obriga o compilador a reclamar se um código novo for criado sem orientação.

## 8. Mapeamento HTTP

Cinco situações distintas, sempre com status distintos e o mesmo corpo de erro `{ "error": { "code", "message" } }`, para o provedor decidir pelo status se pode reenviar:

| Situação | Status | Reenviar? |
|---|---|---|
| Payload inválido, header ausente, cursor ou `limit` inválidos | `400` | Só depois de corrigir |
| Wallet ou transação inexistente | `404` | Não |
| Conflito de idempotência, ou wallet duplicada | `409` | Não, com este conteúdo |
| Rejeição por regra de negócio | `422` | Conforme o `providerAction` |
| Aceita com processamento pendente (`PENDING_REFERENCE`) | `202` | Não é preciso |
| Processada, nova ou replay | `200` | Não é preciso |
| Falha transitória (banco fora, conflito de concorrência) | `503` + `Retry-After` | **Sim**, com a mesma chave |
| Erro interno | `500`, sem detalhes | Com cuidado |

O mapeamento é uma função só (`src/interfaces/http/http-error-mapper.ts`), usada por todos os endpoints, e os status das transações saem de `httpStatusFor`. Testes: `http-transactions.test.ts` e `http-wallets.test.ts`.

## 9. Outbox transacional e publisher

Os eventos são gravados em `outbox_messages` **na mesma transação SQL** da mudança financeira: ou a transação, o ledger, o saldo, a inbox e o evento são confirmados juntos, ou nenhum é. Nada é publicado antes do commit, porque o publisher só enxerga linhas já confirmadas. Teste: `outbox-atomicity.test.ts` executa a aposta inteira e **força uma falha no fim**; transação, ledger, saldo, inbox e outbox somem juntos.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive `LOSS` |
| `WalletBalanceChanged` | Somente quando o saldo muda (e na abertura de wallet com saldo inicial) |
| `WagerTransactionRejected` | Rejeição por regra de negócio |
| `WagerTransactionPendingReference` | A referência ainda não chegou |

Um replay **não emite eventos**: eles nasceram na primeira execução (`outbox-atomicity.test.ts`: 50 envios simultâneos da mesma aposta geram exatamente dois eventos).

**Envelope** (`src/domain/integration-event.ts`): `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt` (ISO-8601), `version` e `data`. O `data` carrega `MoneyProps` (string decimal), nunca uma instância de `Money`, e o payload da outbox passa por uma ida e volta em JSON, o que garante um JSON estável e versionável. O `eventId` é também o id da linha da outbox: um evento existe uma única vez. O `causationId` é o id da transação que o causou.

**`aggregateId` é sempre o `walletId`**, e vira o `MessageGroupId` da fila FIFO de saída.

### Publisher

`src/infrastructure/persistence/mikro-outbox-store.ts`, dentro de **uma transação**:

1. Seleciona até 50 mensagens devidas (não publicadas, sem hora marcada ou com a hora já chegada), por `occurred_at, id`, com **`FOR UPDATE SKIP LOCKED`**.
2. Publica cada uma no SQS (`MessageGroupId` = wallet, `MessageDeduplicationId` = `eventId`).
3. Sucesso: `markPublished`. Falha: `scheduleRetry`, que soma uma tentativa e marca a próxima com **backoff exponencial** (1 s, 2 s, 4 s... com teto de 5 minutos).
4. Grava o resultado e confirma.

Vários publishers ao mesmo tempo funcionam porque cada um **pula** as linhas que outro já reservou, então ninguém espera ninguém e o mesmo evento não vai para dois publishers ao mesmo tempo. A outbox **nunca vai para uma DLQ**: perder um evento confirmado é proibido, então ela continua tentando para sempre, e o atraso aparece em `wager_outbox_lag_seconds`.

| Cenário | O que acontece | Teste |
|---|---|---|
| 4 publishers sobre 40 eventos | Cada evento sai exatamente uma vez | `outbox-relay.test.ts` |
| Dois publishers começando juntos | Reservam lotes diferentes (10 e 10), sem um esperar o outro | `outbox-relay.test.ts` |
| Morre **antes** de publicar | A reserva é liberada (a transação é desfeita); outra instância publica, uma vez | `outbox-relay.test.ts` |
| Morre **depois** de publicar, antes do commit | O evento continua pendente e **sai de novo, com o mesmo `eventId`** (4 envios, 2 eventos distintos) | `outbox-relay.test.ts` |
| O SQS de eventos fica fora | As falhas sobem, nada é dado como publicado, e o lag cresce | `metrics-workers.test.ts` |
| Processo derrubado com `kill -9` | Os eventos dele não se perdem: outro processo os publica | `multiprocess.test.ts`, `bun run stack:failover` |

**A publicação é at-least-once.** A repetição é segura porque o consumidor descarta pelo `eventId`. O SQS FIFO também descarta envios com o mesmo `MessageDeduplicationId` por 5 minutos, mas **não contamos com isso**: é uma otimização, e a garantia é do consumidor.

**Custo conhecido.** O publisher mantém a transação (e o lock das linhas reservadas) aberta enquanto chama o SQS. O lote de 50 limita o tempo, mas, se o SQS ficar lento, as conexões do pool ficam ocupadas por mais tempo. A alternativa seria reservar por uma coluna de concessão (*lease*) e publicar fora da transação; não foi adotada para manter o fluxo simples e a exclusão mútua inteiramente no banco.

**Ordem entre eventos de uma wallet é melhor-esforço.** A fila FIFO preserva a ordem dentro do grupo, mas retries da outbox e publishers paralelos podem inverter eventos, e o `occurred_at` vem do relógio de cada instância. Por isso todo `WalletBalanceChanged` carrega a `walletVersion`, que o consumidor deve usar para reordenar.

## 10. Inbox e consumidor da fila

Fila de entrada `wager-transactions.fifo` (visibilidade de 30 s) e DLQ `wager-transactions-dlq.fifo`, criadas por `infra/localstack-init.sh`. O consumidor (`src/infrastructure/sqs/wager-queue-consumer.ts`) **reutiliza o mesmo caso de uso da API HTTP**: a mensagem é convertida no mesmo comando.

### Inbox

`UNIQUE (consumer_name, message_id)`, gravada **na mesma transação** do efeito e conferida **depois de travar a wallet**, de modo que duas entregas simultâneas da mesma mensagem são serializadas e a segunda vê a primeira. Uma mensagem repetida devolve o resultado original sem repetir efeito. O mesmo `messageId` com **conteúdo diferente** é erro permanente (`INBOX_PAYLOAD_MISMATCH`). Testes: `inbox.test.ts` (30 entregas simultâneas: um débito, dois eventos, uma linha de inbox) e a falha no fim, que desfaz a inbox junto.

### Classificação dos erros

| Erro | Tratamento | Por quê |
|---|---|---|
| Transação processada, rejeitada ou pendente | **Ack** | É um resultado válido: a rejeição foi persistida e o evento, emitido |
| Mensagem já vista na inbox | **Ack**, sem efeito | A redelivery foi absorvida |
| Mesma idempotency key com payload diferente | **Ack terminal**, sem DLQ (`business_conflict`) | Nunca terá sucesso, e o primeiro pedido já produziu o efeito; vira log e métrica |
| JSON inválido, campo faltando, valor inválido, wallet inexistente, `messageId` repetido com outro conteúdo | **DLQ imediata** | Reenviar não resolve |
| Banco fora, timeout, conflito de concorrência, **qualquer erro inesperado** | **Retry** com backoff (1 s, 2 s, 4 s...) via visibilidade, até 5 recebimentos; depois, DLQ | Pode ser passageiro; o limite impede um loop infinito |

Todo erro que não sabemos classificar é tratado como **transitório**, a escolha conservadora: tenta de novo, e o limite o leva à DLQ. Mensagens na DLQ carregam `failureKind`, `errorCode`, `errorMessage`, `receiveCount` e `originalMessageId`. O consumidor envia à DLQ **antes** de apagar a original, então uma morte no meio não perde nada. A política de redrive da própria fila (`maxReceiveCount` 5) é a rede de segurança para esse caso.

### Ack, ordem e desligamento

- **Ack só depois do commit.** Se o `DeleteMessage` falhar ou o processo morrer entre o commit e o ack, a mensagem volta e a **inbox** a absorve. Teste: `queue-consumer.test.ts` ("worker morto depois do commit e antes do ack").
- **Ordem por wallet.** As mensagens de um mesmo `MessageGroupId` de um lote são tratadas em sequência, e grupos diferentes em paralelo. Se uma falha de forma transitória, o resto do grupo é devolvido à fila, para não furar a ordem. Teste: um prêmio antes de uma aposta só fecha se a ordem for respeitada.
- **Desligamento (SIGTERM).** O consumidor para de buscar, **aborta a espera longa** do SQS, termina a mensagem em andamento (commit e ack) e devolve as ainda não iniciadas com visibilidade 0. Os laços do publisher e do worker de referências terminam a rodada em andamento. O Nest chama esses *shutdown hooks* **antes** de fechar o servidor e o banco. Testes: `queue-consumer-resilience.test.ts`, `e2e.test.ts` (desliga uma instância no meio de 96 mensagens), e `bun run stack:failover` (com `docker stop`, o container sai em cerca de 2 s e com código 0).

## 11. Referências fora de ordem

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`, resolvido por `(providerId, id externo)`. Se a referência ainda não existe (ou ainda espera a sua própria), a reversão é gravada como `PENDING_REFERENCE`, **sem mexer em saldo**, e o evento `WagerTransactionPendingReference` é emitido.

**Política** (`src/domain/pending-reference-policy.ts`): **12 checagens**, com espera de 5 s, 10 s, 20 s, 40 s, 80 s, 160 s, 320 s e depois 600 s fixos. A última acontece **3.635 s (60 min e 35 s)** depois da chegada da reversão.

**Por que esse limite.** Num provedor at-least-once, uma referência fora de ordem costuma chegar em segundos ou poucos minutos. Uma hora cobre atrasos e filas represadas, e o limite é finito, então nenhuma transação fica pendurada para sempre. A política é um objeto configurável.

**Esgotado o limite**, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` (`FIX_PAYLOAD`), e o evento `WagerTransactionRejected` é publicado. Teste: `pending-reference-worker.test.ts` percorre as 12 checagens com um relógio simulado, confere os 3.635 s, verifica que 1 ms antes da hora **nada acontece** e que o saldo e a `version` não mudam.

**O worker** (`src/application/reprocess-pending-references.ts`) procura as devidas (`status = PENDING_REFERENCE` e `next_reference_attempt_at <= now`) e reprocessa cada uma **na mesma transação e com a mesma regra de decisão** da chegada, com a wallet travada na mesma ordem dos outros caminhos. Depois do lock, **relê a transação** e pula se outro worker já a resolveu. Por isso vários workers podem listar as mesmas pendências sem aplicar o efeito duas vezes (o defeito do Identity Map, descrito na seção 3, foi achado aqui). Quem continua esperando não emite evento novo. Uma falha de uma transação não derruba o ciclo: ela continua devida.

O banco impõe a consistência: `wager_tx_next_reference_consistent` exige que "tem próxima checagem" seja verdade se, e somente se, o status é `PENDING_REFERENCE`.

| Cenário | Teste |
|---|---|
| A referência chega, e a reversão é aplicada no ciclo devido | `pending-reference-worker.test.ts` |
| A referência chega, mas a regra recusa (valor diferente) | idem |
| `ROLLBACK` → `REFUND` → `BET`, tudo fora de ordem, converge em até 3 ciclos | idem |
| 10 reprocessamentos simultâneos: um aplica, nove ignoram | idem |
| 4 workers sobre 20 pendentes: cada reversão uma vez, 5 eventos por wallet | idem |
| App inteiro: o REFUND chega por HTTP (`202`), a BET depois, e o worker fecha o saldo sozinho | `e2e.test.ts` |

## 12. Reconciliação

`POST /wallets/:walletId/reconciliation` lê o saldo guardado e a soma do ledger **numa única consulta SQL**, do mesmo *snapshot* do Postgres, sem lock. Assim, apostas concorrentes não geram divergência falsa (teste: 15 reconciliações no meio de 40 apostas simultâneas, nenhuma acusa divergência).

A resposta traz `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. **Uma divergência nunca é corrigida em silêncio**: aparece na resposta (`consistent: false`), no log (`reconciliation_divergence`, em `warn`) e na métrica `wager_reconciliation_divergences_total`. Um ledger corrompido pode somar **negativo**; o cálculo usa uma conversão com sinal, para que isso apareça como divergência e não como erro de validação do `Money`. Testes: `ledger-reconciliation.test.ts`, incluindo a adulteração do saldo guardado (o saldo adulterado continua adulterado depois da chamada, e a métrica sobe em exatamente 1).

**Custo.** A soma percorre todos os lançamentos da wallet, então o custo cresce com o tamanho do ledger. Para wallets com milhões de lançamentos, o caminho seria um ponto de verificação periódico (soma até um `seq` conhecido).

## 13. Observabilidade

**Logs** (`src/infrastructure/observability/json-logger.ts`): uma linha de JSON por evento, com os campos no **nível principal** (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`), para um coletor filtrar direto. Os campos do evento nunca sobrescrevem `level`, `timestamp` e `context`, e uma quebra de linha no texto não quebra a linha do log. **Nenhum log leva payload nem valor de transação**; a única exceção é a diferença numa divergência de reconciliação, necessária para diagnosticar.

**Correlação.** A API aceita `X-Correlation-Id` (só `A-Za-z0-9._:-` até 100 caracteres, para um valor livre não forjar linhas de log), devolve o valor na resposta e o propaga até os logs e os eventos da outbox; sem o header, gera um UUID. Na fila, o `correlationId` é o `messageId`. Ele **não entra no hash de idempotência**.

**Métricas** (`GET /metrics`, formato Prometheus, registro próprio por instância):

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{status,kind}` | Transações por estado e tipo, contadas **depois do commit** |
| `wager_duplicates_total{source}` | Duplicatas detectadas (`idempotency` ou `inbox`); um replay **não** conta como transação nova |
| `wager_processing_duration_seconds` | Latência do processamento, do início ao commit |
| `wager_wallet_lock_wait_seconds` | Espera pelo lock da wallet |
| `wager_lock_conflicts_total{type}` | `duplicate_key_retry` e `version_conflict` |
| `wager_consumer_messages_total{result}` | Mensagens da fila: processada, duplicada, conflito de negócio, devolvida |
| `wager_consumer_retries_total` | Retries por erro transitório |
| `wager_dlq_messages_total{reason}` | Mensagens enviadas à DLQ (`permanent` ou `max-attempts`) |
| `wager_outbox_published_total` e `wager_outbox_publish_failures_total` | Publicações e falhas do publisher |
| `wager_outbox_pending` e **`wager_outbox_lag_seconds`** | Eventos pendentes e a idade do mais antigo, lidos do banco **na hora do scrape** |
| `wager_pending_reference_total{outcome}` | Desfechos do worker de referências |
| `wager_reconciliation_checks_total` e `wager_reconciliation_divergences_total` | Reconciliações e divergências |

Nenhuma etiqueta leva valor monetário nem id de wallet ou de jogador (teste: o scrape não contém o valor de uma aposta nem os ids). A telemetria nunca derruba o processamento: um erro nela é engolido.

**Health.** `GET /health/live` não depende de nada externo. `GET /health/ready` testa o PostgreSQL e o SQS, cada um com timeout de 2 s, e responde `503` dizendo qual caiu (`health-ready.test.ts` derruba cada um e confere que só ele aparece como `down`).

## 14. Limitações conhecidas e o que não foi provado

Esta seção é deliberadamente franca: o que **funciona e está provado** está nas seções anteriores, junto do teste que o prova. Aqui está o resto.

### Comportamento e escolhas com custo

1. **O status `FAILED` existe, mas nada o produz.** Ele está no domínio (`WagerTransaction.fail`), no banco (constraints de consistência) e na taxonomia (`PROCESSING_FAILED`), mas nenhum caminho do código chega a ele. Um erro de infraestrutura passa por retry e, esgotado o limite, a **mensagem** vai para a DLQ, **sem** uma transação persistida. Para usá-lo, um erro permanente depois de a transação já ter sido aceita teria de gravá-la como `FAILED` antes de a mensagem seguir para a DLQ. Optamos por não inventar um uso sem um cenário real que o exija.
2. **A ordem dos eventos de uma wallet é melhor-esforço.** O FIFO preserva a ordem de chegada dentro do grupo, mas retries da outbox e publishers paralelos podem invertê-la, e o `occurred_at` vem do relógio de cada instância. O consumidor deve reordenar pela `walletVersion` (presente em todo `WalletBalanceChanged`).
3. **O publisher segura uma transação aberta enquanto chama o SQS** (lote de 50). Se o SQS ficar lento, conexões do pool ficam ocupadas por mais tempo. A alternativa (concessão por coluna e publicação fora da transação) não foi adotada.
4. **Depois de um `kill -9` do consumidor, o grupo da wallet fica parado até o prazo de visibilidade vencer** (30 s). É o custo de usar a visibilidade do SQS como concessão; nos testes, a mensagem volta e o processamento termina.
5. **Todo erro desconhecido é tratado como transitório.** Um defeito nosso passa por 5 recebimentos antes de ir para a DLQ. É a escolha conservadora (não descarta o que talvez dê certo), com o custo de atrasar a descoberta de um bug.
6. **Um conflito de idempotência na fila é confirmado, não vai para a DLQ.** É uma decisão, não uma exigência: o primeiro pedido já produziu o efeito e este nunca terá sucesso. Um operador que prefira ver esses casos na DLQ troca uma linha da classificação.
7. **O backoff não tem jitter.** O teto de 5 minutos e a concorrência já espalham as tentativas, e o código determinístico é mais fácil de testar.
8. **O lag da outbox mistura relógios.** Ele é `now()` do banco menos o `occurred_at`, gravado com o relógio da instância. Um desvio de relógio entre instâncias distorce o valor.
9. **A reconciliação custa O(n)** no tamanho do ledger da wallet. Para milhões de lançamentos, o caminho seria um ponto de verificação periódico.
10. **Reversão parcial está fora de escopo**, como no case: o valor da reversão tem de ser igual ao da referência.

### Crescimento sem limpeza

11. **`inbox_messages` e `outbox_messages` só crescem.** Não há rotina de remoção nem particionamento. Em produção, a inbox precisaria de retenção (por exemplo, apagar mensagens processadas mais velhas que o maior prazo de redelivery) e a outbox de arquivamento dos já publicados. O índice parcial das não publicadas mantém o publisher rápido, mas a tabela cresce.
12. **O ledger é imutável por desenho**, então nem os testes limpam o que criam: o banco de desenvolvimento só cresce. `docker compose --profile app down -v` recomeça do zero.
13. **Não há ferramenta de reprocessamento da DLQ.** As mensagens ficam lá com `failureKind`, `errorCode` e `receiveCount`, mas devolvê-las à fila é manual.

### O que os testes não cobrem

14. **O ambiente é o LocalStack, não a AWS.** A semântica de FIFO, visibilidade e deduplicação foi observada ali. Diferenças de comportamento em produção (latência, limites, janela de deduplicação) não foram testadas.
15. **"Vários processos" significa vários processos do sistema operacional na mesma máquina e no mesmo Docker.** Não há teste com partição de rede, relógios dessincronizados nem máquinas diferentes.
16. **Não testamos o PostgreSQL reiniciando no meio do processamento.** O banco fora do ar é coberto no `readiness`, e as falhas transitórias do consumidor são simuladas com um caso de uso que falha, não com um banco que cai de verdade.
17. **O contador `wager_consumer_retries_total` não tem teste de ponta a ponta**, só o da tradução do evento (`consumer-metrics.test.ts`) e o do consumidor com falha simulada.
18. **Os testes de multiprocesso e de ponta a ponta dependem de tempo** (esperas, prazos de visibilidade) e levam de 1 a 3 minutos. Eles foram estabilizados (3 rodadas completas seguidas sem falha depois de corrigir um defeito de ordem do próprio teste), mas continuam sendo os mais sensíveis a uma máquina lenta.
19. **`bun run stack:failover` não faz parte de `bun run test`**: ele exige a pilha em containers e não pode rodar junto da suíte. Foi executado manualmente e passou em todas as verificações.

### Segurança e implantação

20. **As credenciais do `docker-compose.yml` são de desenvolvimento** (`wager/wager`, `test/test`), e o PostgreSQL e o LocalStack expõem portas no host. Não servem para produção.
21. **`/metrics` e `/health/*` são abertos**, como o case prevê para a saúde. As métricas não levam valores nem ids, mas expõem contagens.
22. **A imagem fixa o Bun em 1.4.4.** É reprodutível, mas exige atualização deliberada.
