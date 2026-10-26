import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../src/infrastructure/observability/json-logger';

const at = new Date('2026-10-26T12:00:00.000Z');

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger((l) => lines.push(l), () => at);
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe('JsonLogger', () => {
  test('texto simples vira uma linha de JSON com nível, hora e contexto', () => {
    const { logger, lines, parsed } = capture();
    logger.log('olá', 'Wager');
    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toEqual({
      level: 'log', timestamp: '2026-10-26T12:00:00.000Z', context: 'Wager', msg: 'olá',
    });
  });

  test('os campos do objeto ficam no nível principal, prontos para filtrar', () => {
    const { logger, parsed } = capture();
    logger.log(
      { event: 'transaction_recorded', correlationId: 'c1', transactionId: 't1', walletId: 'w1', providerId: 'p1', messageId: 'm1' },
      'Wager',
    );
    expect(parsed()[0]).toMatchObject({
      level: 'log', context: 'Wager', event: 'transaction_recorded',
      correlationId: 'c1', transactionId: 't1', walletId: 'w1', providerId: 'p1', messageId: 'm1',
    });
    expect(parsed()[0]).not.toHaveProperty('message');
  });

  test('o conteúdo do evento nunca forja level, timestamp ou context', () => {
    const { logger, parsed } = capture();
    logger.warn({ level: 'debug', timestamp: '1999-01-01', context: 'Outro', event: 'x' }, 'Real');
    expect(parsed()[0]).toMatchObject({
      level: 'warn', timestamp: '2026-10-26T12:00:00.000Z', context: 'Real', event: 'x',
    });
  });

  test('erro com stack e contexto', () => {
    const { logger, parsed } = capture();
    logger.error('falhou', 'Error: x\n  at y', 'HttpErrorFilter');
    expect(parsed()[0]).toMatchObject({
      level: 'error', context: 'HttpErrorFilter', msg: 'falhou', stack: 'Error: x\n  at y',
    });
  });

  test('uma instância de Error vira nome, mensagem e stack', () => {
    const { logger, parsed } = capture();
    logger.error(new TypeError('quebrou'), 'Ctx');
    expect(parsed()[0]).toMatchObject({ level: 'error', errorName: 'TypeError', msg: 'quebrou', context: 'Ctx' });
  });

  test('quebra de linha no texto não quebra a linha do log', () => {
    const { logger, lines } = capture();
    logger.log('linha 1\nlinha 2 {"level":"fake"}', 'X');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('linha 1\nlinha 2 {"level":"fake"}');
  });

  test('objeto circular não derruba o logger', () => {
    const { logger, lines } = capture();
    const loop: Record<string, unknown> = { event: 'x' };
    loop.self = loop;
    logger.log(loop, 'X');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe('log');
  });

  test('todos os níveis existem', () => {
    const { logger, parsed } = capture();
    logger.log('a'); logger.error('b'); logger.warn('c'); logger.debug?.('d'); logger.verbose?.('e'); logger.fatal?.('f');
    expect(parsed().map((l) => l.level)).toEqual(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
  });
});
