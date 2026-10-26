import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { $ } from 'bun';
import { createSqsClient, wagerDlqUrl, wagerQueueUrl } from '../src/infrastructure/sqs/sqs-client';

// Pré-requisito: `bun run stack:up` (Postgres, LocalStack, migrations e as 3 instâncias).
const root = `${import.meta.dir}/..`;
const sqs = createSqsClient();
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const id = () => crypto.randomUUID();
const json = { 'content-type': 'application/json' };
const money = (amount: string) => ({ amount, currency: 'BRL' });

const WALLETS = 16;
const PER_WALLET = 50; // 16 x 50 = 800 apostas de 1.00 contra saldo 100.00
const TOTAL = WALLETS * PER_WALLET;
const SURVIVOR = 'http://127.0.0.1:3003';

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'OK    ' : 'FALHOU'} ${label}`);
  if (!ok) failures += 1;
};

async function psql(sql: string): Promise<string> {
  const out = await $`docker compose exec -T postgres psql -U wager -d wager -t -A -c ${sql}`.cwd(root).text();
  return out.trim();
}
const num = async (sql: string) => Number(await psql(sql));

async function waitUntil(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(250);
  }
  return cond();
}

async function queueDepth(url: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  const a = res.Attributes ?? {};
  return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) + Number(a.ApproximateNumberOfMessagesDelayed ?? 0);
}

if ((await queueDepth(wagerQueueUrl())) !== 0 || (await queueDepth(wagerDlqUrl())) !== 0) {
  console.log('A fila de entrada ou a DLQ não está vazia. Espere esvaziar (ou pare outros testes) e rode de novo.');
  process.exit(2);
}

// 1) Wallets, criadas pela instância que vai sobreviver.
const wallets = await Promise.all(
  Array.from({ length: WALLETS }, async () => {
    const res = await fetch(`${SURVIVOR}/wallets`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ playerId: id(), initialBalance: money('100.00') }),
    });
    return (await res.json()) as { id: string; playerId: string };
  }),
);
const inList = wallets.map((w) => `'${w.id}'`).join(',');
const betsDone = () => num(`select count(*) from wager_transactions where kind = 'BET' and wallet_id in (${inList})`);
log(`${WALLETS} wallets criadas`);

// 2) Enfileira as apostas.
const outbound = wallets.flatMap((w) =>
  Array.from({ length: PER_WALLET }, () => {
    const ext = id();
    return {
      groupId: w.id,
      body: {
        messageId: `msg-${id()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
        data: {
          providerId: 'prov', externalTransactionId: ext, idempotencyKey: `prov:${ext}`,
          playerId: w.playerId, walletId: w.id, roundId: 'r1', gameId: 'g1', kind: 'BET', money: money('1.00'),
        },
      },
    };
  }),
);
for (let i = 0; i < outbound.length; i += 100) {
  await Promise.all(
    outbound.slice(i, i + 100).map((m) =>
      sqs.send(new SendMessageCommand({
        QueueUrl: wagerQueueUrl(), MessageBody: JSON.stringify(m.body),
        MessageGroupId: m.groupId, MessageDeduplicationId: m.body.messageId,
      })),
    ),
  );
}
log(`${TOTAL} mensagens enfileiradas`);

// 3) No meio do processamento: SIGTERM numa instância e SIGKILL em outra, ao mesmo tempo.
await waitUntil(async () => (await betsDone()) >= 10, 60_000);
const doneAtStop = await betsDone();
log(`interrompendo app1 (docker stop) e app2 (docker kill) com ${doneAtStop}/${TOTAL} apostas feitas`);
const stopStarted = Date.now();
await Promise.all([
  $`docker compose --profile app stop -t 30 app1`.cwd(root).quiet(),
  $`docker compose --profile app kill app2`.cwd(root).quiet(),
]);
const stopMs = Date.now() - stopStarted;
check(doneAtStop < TOTAL, `a interrupção pegou o processamento no meio (${doneAtStop} de ${TOTAL})`);
check(stopMs < 30_000, `docker stop terminou antes do limite de 30 s (${stopMs} ms)`);

const logs = await $`docker compose --profile app logs app1`.cwd(root).text();
check(logs.includes('workers encerrados'), 'app1 passou pelos shutdown hooks dentro do container');
const exitCode = (await $`docker inspect -f {{.State.ExitCode}} wagering-processor-app1-1`.cwd(root).text()).trim();
log(`código de saída de app1: ${exitCode}`);

// 4) Só a app3 sobra: o que a app2 segurava volta à fila depois do prazo de visibilidade.
const converged = await waitUntil(
  async () => (await num(`select count(*) from wallets where id in (${inList}) and balance = 50.00`)) === WALLETS,
  180_000,
);
check(converged, `todas as ${WALLETS} wallets chegaram a 50.00 só com a app3 viva`);
check((await betsDone()) === TOTAL, `exatamente ${TOTAL} apostas gravadas, nenhuma a mais`);
check(
  (await num(`select count(*) from wallet_ledger_entries where direction = 'DEBIT' and wallet_id in (${inList})`)) === TOTAL,
  `${TOTAL} débitos no ledger`,
);

const drained = await waitUntil(
  async () => (await num(`select count(*) from outbox_messages where published_at is null and aggregate_id in (${inList})`)) === 0,
  90_000,
);
check(drained, 'todos os eventos da outbox foram publicados');
const events = await num(`select count(*) from outbox_messages where aggregate_id in (${inList})`);
check(events === WALLETS * (1 + PER_WALLET * 2), `${events} eventos na outbox (esperado ${WALLETS * (1 + PER_WALLET * 2)})`);
check((await queueDepth(wagerDlqUrl())) === 0, 'DLQ vazia');

let reconciled = true;
for (const w of wallets) {
  const r = (await (await fetch(`${SURVIVOR}/wallets/${w.id}/reconciliation`, { method: 'POST' })).json()) as {
    consistent: boolean; checkedEntries: number;
  };
  if (!r.consistent || r.checkedEntries !== 1 + PER_WALLET) reconciled = false;
}
check(reconciled, 'reconciliação consistente em todas as wallets (51 lançamentos cada)');

// 5) Religa as instâncias paradas.
await $`docker compose --profile app up -d --wait --wait-timeout 90`.cwd(root).quiet();
const ready = await Promise.all([3001, 3002, 3003].map(async (p) => (await fetch(`http://127.0.0.1:${p}/health/ready`)).status));
check(ready.every((s) => s === 200), 'as três instâncias voltaram e estão prontas');

console.log(failures === 0 ? '\nTUDO CERTO' : `\n${failures} verificação(ões) falharam`);
process.exit(failures === 0 ? 0 : 1);
