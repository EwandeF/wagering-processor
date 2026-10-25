import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '../src/workers/polling-loop';

async function until(condition: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe('PollingLoop', () => {
  test('repete na hora enquanto houver trabalho, sem dormir entre as rodadas', async () => {
    const results = [3, 2, 1, 0];
    let calls = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 60_000,
      tick: async () => results[calls++] ?? 0,
    });
    const t0 = Date.now();
    loop.start();
    await until(() => calls >= 4);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await loop.stop();
  });

  test('sem trabalho, dorme o intervalo entre as rodadas', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 100,
      tick: async () => {
        calls += 1;
        return 0;
      },
    });
    loop.start();
    await Bun.sleep(450);
    await loop.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(6);
  });

  test('erro numa rodada não derruba o laço', async () => {
    const errors: string[] = [];
    let calls = 0;
    const loop = new PollingLoop({
      name: 'laço-x',
      intervalMs: 20,
      tick: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return 0;
      },
      onError: (name, error) => errors.push(`${name}:${(error as Error).message}`),
    });
    loop.start();
    await until(() => calls >= 3);
    await loop.stop();
    expect(errors).toEqual(['laço-x:boom']);
  });

  test('um observador de erro com defeito também não derruba o laço', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 20,
      tick: async () => {
        calls += 1;
        throw new Error('sempre falha');
      },
      onError: () => {
        throw new Error('o observador também falha');
      },
    });
    loop.start();
    await until(() => calls >= 3);
    await loop.stop();
  });

  test('stop acorda o sono e termina na hora', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 60_000,
      tick: async () => {
        calls += 1;
        return 0;
      },
    });
    loop.start();
    await until(() => calls >= 1);
    const t0 = Date.now();
    await loop.stop();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('stop espera a rodada em andamento terminar', async () => {
    let started = false;
    let finished = false;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 10,
      tick: async () => {
        started = true;
        await Bun.sleep(300);
        finished = true;
        return 1;
      },
    });
    loop.start();
    await until(() => started);
    await loop.stop();
    expect(finished).toBe(true);
  });

  test('chamar start duas vezes não cria dois laços', async () => {
    let active = 0;
    let max = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 10,
      tick: async () => {
        active += 1;
        max = Math.max(max, active);
        await Bun.sleep(30);
        active -= 1;
        return 1;
      },
    });
    loop.start();
    loop.start();
    await Bun.sleep(150);
    await loop.stop();
    expect(max).toBe(1);
  });

  test('depois de stop, start não faz nada', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 't',
      intervalMs: 10,
      tick: async () => {
        calls += 1;
        return 0;
      },
    });
    await loop.stop();
    loop.start();
    await Bun.sleep(100);
    expect(calls).toBe(0);
  });
});
