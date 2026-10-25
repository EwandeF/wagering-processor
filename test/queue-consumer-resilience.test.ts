import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { WagerTransactionKind as Kind } from '../src/domain/enums';
import config from '../src/infrastructure/database/mikro-orm.config';
import { MikroWagerUnitOfWork } from '../src/infrastructure/persistence/mikro-wager-unit-of-work';
import { expectLedgerMatchesWallet, openWallet, uid } from './helpers';
import {
  type TestQueues,
  type UseCase,
  createTestQueues,
  enqueue,
  expectQueueEmpty,
  makeConsumer,
  ofType,
  pollUntil,
  takeFromDlq,
  wagerMessage,
} from './queue-helpers';

let orm: MikroORM;
let real: SubmitWagerTransaction;
let queues: TestQueues;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  real = new SubmitWagerTransaction(new MikroWagerUnitOfWork(orm));
  queues = await createTestQueues();
});
afterAll(async () => {
  await queues.remove();
  await orm.close(true);
});

describe('consumidor: erros transitórios', () => {
  test('retry com backoff crescente e depois sucesso, com um único efeito', async () => {
    const w = await openWallet(orm, '100.00');
    let calls = 0;
    const flaky: UseCase = {
      execute: async (cmd) => {
        calls += 1;
        if (calls <= 2) throw new Error('banco indisponível');
        return real.execute(cmd);
      },
    };
    await enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '25.00'), w.walletId);

    const { consumer, events } = makeConsumer(queues, flaky);
    await pollUntil([consumer], () => ofType(events, 'processed').length === 1);

    const retries = ofType(events, 'retry') as { receiveCount: number; delaySeconds: number }[];
    expect(retries.map((r) => r.receiveCount)).toEqual([1, 2]);
    expect(retries.map((r) => r.delaySeconds)).toEqual([1, 2]);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
    await expectQueueEmpty(queues);
  }, 30_000);

  test('esgotado o limite de tentativas, a mensagem vai para a DLQ', async () => {
    const w = await openWallet(orm, '100.00');
    const alwaysDown: UseCase = {
      execute: async () => {
        throw new Error('banco indisponível');
      },
    };
    const msg = wagerMessage(w, uid(), Kind.Bet, '25.00');
    await enqueue(queues, msg, w.walletId);

    const { consumer, events } = makeConsumer(queues, alwaysDown, 3);
    await pollUntil([consumer], () => ofType(events, 'dead-letter').length === 1);

    expect(ofType(events, 'retry')).toHaveLength(2);
    expect(ofType(events, 'dead-letter')[0]).toMatchObject({
      reason: 'max-attempts', receiveCount: 3,
    });
    const [dead] = await takeFromDlq(queues, (b) => b.includes(msg.messageId));
    expect(dead!.attributes).toMatchObject({ failureKind: 'max-attempts', receiveCount: '3' });
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
    await expectQueueEmpty(queues);
  }, 30_000);
});

describe('consumidor: vários workers e desligamento', () => {
  test('3 consumidores sobre 30 mensagens: cada uma é processada exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, '100.00')));
    await Promise.all(
      wallets.flatMap((w) =>
        [1, 2, 3].map(() => enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId)),
      ),
    );

    const workers = Array.from({ length: 3 }, () => makeConsumer(queues, real));
    const total = () => workers.reduce((n, x) => n + ofType(x.events, 'processed').length, 0);
    await pollUntil(workers.map((x) => x.consumer), () => total() === 30, 45_000);

    for (const w of wallets) {
      const s = await expectLedgerMatchesWallet(orm, w.walletId);
      expect(s.balance).toBe('70.00');
      expect(s.debits).toBe(3);
    }
    expect(workers.flatMap((x) => ofType(x.events, 'dead-letter'))).toHaveLength(0);
    await expectQueueEmpty(queues);
  }, 60_000);

  test('SIGTERM: termina o que está em andamento e devolve o resto à fila', async () => {
    const w = await openWallet(orm, '100.00');
    let started = 0;
    const slow: UseCase = {
      execute: async (cmd) => {
        started += 1;
        await Bun.sleep(400);
        return real.execute(cmd);
      },
    };
    for (let i = 0; i < 5; i++) {
      await enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '10.00'), w.walletId);
    }

    const first = makeConsumer(queues, slow);
    first.consumer.start();
    const deadline = Date.now() + 15_000;
    while (started < 1 && Date.now() < deadline) await Bun.sleep(50);
    expect(started).toBeGreaterThanOrEqual(1);

    await first.consumer.stop();

    // O que estava em andamento terminou por completo: commit e ack.
    const done = ofType(first.events, 'processed').length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect(done).toBeLessThan(5);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).debits).toBe(done);

    // O resto continua na fila, e outro worker assume sem perder nem duplicar nada.
    const second = makeConsumer(queues, real);
    await pollUntil(
      [second.consumer],
      () => ofType(second.events, 'processed').length === 5 - done,
    );

    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(5);
    expect(s.balance).toBe('50.00');
    await expectQueueEmpty(queues);
  }, 60_000);
});
