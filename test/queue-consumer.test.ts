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
  count,
  createTestQueues,
  enqueue,
  expectQueueEmpty,
  makeConsumer,
  ofType,
  outboxCount,
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

const consumerFor = (useCase: UseCase = real) => makeConsumer(queues, useCase);

describe('consumidor: caminho feliz', () => {
  test('processa, grava inbox e outbox e confirma a mensagem só depois do commit', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = wagerMessage(w, uid(), Kind.Bet, '25.00');
    await enqueue(queues, msg, w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'processed').length === 1);

    expect(ofType(events, 'processed')[0]).toMatchObject({
      messageId: msg.messageId, status: 'PROCESSED', duplicateMessage: false,
    });
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.balance).toBe('75.00');
    expect(s.debits).toBe(1);
    expect(await outboxCount(orm, w.walletId)).toBe(2);
    expect(
      await count(
        orm,
        "select count(*)::int as n from inbox_messages where consumer_name = 'wager-transactions' and message_id = ?",
        [msg.messageId],
      ),
    ).toBe(1);
    await expectQueueEmpty(queues);
  });

  test('rejeição de negócio é um resultado válido: persiste e confirma', async () => {
    const w = await openWallet(orm, '100.00');
    await enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '500.00'), w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'processed').length === 1);

    expect(ofType(events, 'processed')[0]).toMatchObject({ status: 'REJECTED' });
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
    await expectQueueEmpty(queues);
  });

  test('a ordem dentro da wallet é respeitada: o prêmio antes da aposta', async () => {
    const w = await openWallet(orm, '100.00');
    await enqueue(queues, wagerMessage(w, uid(), Kind.Win, '50.00'), w.walletId);
    await enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '120.00'), w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'processed').length === 2);

    // Se a ordem se invertesse, a aposta de 120 seria rejeitada com saldo 100.
    const statuses = ofType(events, 'processed').map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(['PROCESSED', 'PROCESSED']);
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('30.00');
  });
});

describe('consumidor: redelivery', () => {
  test('a mesma mensagem entregue duas vezes não repete o efeito', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = wagerMessage(w, uid(), Kind.Bet, '25.00');
    await enqueue(queues, msg, w.walletId);
    await enqueue(queues, msg, w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'processed').length === 2);

    const flags = ofType(events, 'processed').map(
      (e) => (e as { duplicateMessage: boolean }).duplicateMessage,
    );
    expect(flags.filter(Boolean)).toHaveLength(1);
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
    expect(await outboxCount(orm, w.walletId)).toBe(2);
    await expectQueueEmpty(queues);
  });

  test('worker morto depois do commit e antes do ack: a reentrega não duplica', async () => {
    const w = await openWallet(orm, '100.00');
    let crashed = false;
    const crashAfterCommit: UseCase = {
      execute: async (cmd) => {
        const result = await real.execute(cmd);
        if (!crashed) {
          crashed = true;
          throw new Error('worker morreu antes do ack');
        }
        return result;
      },
    };
    await enqueue(queues, wagerMessage(w, uid(), Kind.Bet, '25.00'), w.walletId);

    const { consumer, events } = consumerFor(crashAfterCommit);
    await pollUntil([consumer], () => ofType(events, 'processed').length === 1);

    expect(ofType(events, 'retry')).toHaveLength(1);
    expect(ofType(events, 'processed')[0]).toMatchObject({ duplicateMessage: true });
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
    expect(await outboxCount(orm, w.walletId)).toBe(2);
    await expectQueueEmpty(queues);
  });

  test('mesma idempotency key com payload diferente: ack terminal, sem DLQ e sem efeito', async () => {
    const w = await openWallet(orm, '100.00');
    const ext = uid();
    await enqueue(queues, wagerMessage(w, ext, Kind.Bet, '25.00'), w.walletId);
    await enqueue(queues, wagerMessage(w, ext, Kind.Bet, '30.00'), w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil(
      [consumer],
      () =>
        ofType(events, 'processed').length === 1 &&
        ofType(events, 'business-conflict').length === 1,
    );

    expect(ofType(events, 'business-conflict')[0]).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
    await expectQueueEmpty(queues);
  });
});

describe('consumidor: erros permanentes vão direto para a DLQ', () => {
  test('JSON inválido', async () => {
    const marker = `lixo-${uid()}`;
    await enqueue(queues, `{"isto nao e json ${marker}`, marker);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'dead-letter').length === 1);

    expect(ofType(events, 'dead-letter')[0]).toMatchObject({
      reason: 'permanent', code: 'MALFORMED_MESSAGE',
    });
    const [dead] = await takeFromDlq(queues, (b) => b.includes(marker));
    expect(dead!.attributes).toMatchObject({
      failureKind: 'permanent', errorCode: 'MALFORMED_MESSAGE',
    });
    await expectQueueEmpty(queues);
  });

  test('valor monetário inválido', async () => {
    const w = await openWallet(orm, '100.00');
    const msg = wagerMessage(w, uid(), Kind.Bet, '10.5');
    await enqueue(queues, msg, w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'dead-letter').length === 1);

    const [dead] = await takeFromDlq(queues, (b) => b.includes(msg.messageId));
    expect(dead!.attributes).toMatchObject({ failureKind: 'permanent', errorCode: 'INVALID_MONEY' });
    expect((await expectLedgerMatchesWallet(orm, w.walletId)).balance).toBe('100.00');
  });

  test('wallet inexistente', async () => {
    const ghost = { walletId: uid(), playerId: uid() };
    const msg = wagerMessage(ghost, uid(), Kind.Bet, '10.00');
    await enqueue(queues, msg, ghost.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil([consumer], () => ofType(events, 'dead-letter').length === 1);

    const [dead] = await takeFromDlq(queues, (b) => b.includes(msg.messageId));
    expect(dead!.attributes).toMatchObject({
      errorCode: 'WALLET_NOT_FOUND', originalMessageId: msg.messageId,
    });
  });

  test('o mesmo messageId com conteúdo diferente', async () => {
    const w = await openWallet(orm, '100.00');
    const original = wagerMessage(w, uid(), Kind.Bet, '25.00');
    const tampered = {
      ...original,
      data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
    };
    await enqueue(queues, original, w.walletId);
    await enqueue(queues, tampered, w.walletId);

    const { consumer, events } = consumerFor();
    await pollUntil(
      [consumer],
      () =>
        ofType(events, 'processed').length === 1 && ofType(events, 'dead-letter').length === 1,
    );

    const [dead] = await takeFromDlq(queues, (b) => b.includes('"99.00"'));
    expect(dead!.attributes).toMatchObject({ errorCode: 'INBOX_PAYLOAD_MISMATCH' });
    const s = await expectLedgerMatchesWallet(orm, w.walletId);
    expect(s.debits).toBe(1);
    expect(s.balance).toBe('75.00');
  });
});
