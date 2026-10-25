import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ORM } from '../src/infrastructure/tokens';

async function boot() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

describe('GET /health/ready', () => {
  test('tudo no ar: 200 com postgres e sqs up', async () => {
    const { app, url } = await boot();
    try {
      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', postgres: 'up', sqs: 'up' });
    } finally {
      await app.close();
    }
  });

  test('SQS fora do ar: 503 e só o sqs aparece como down', async () => {
    const previous = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:9';
    const { app, url } = await boot();
    try {
      const t0 = Date.now();
      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable', postgres: 'up', sqs: 'down' });
      expect(Date.now() - t0).toBeLessThan(5_000); // o timeout de 2s segura a resposta
    } finally {
      if (previous === undefined) delete process.env.SQS_ENDPOINT;
      else process.env.SQS_ENDPOINT = previous;
      await app.close();
    }
  });

  test('PostgreSQL fora do ar: 503, só o postgres aparece como down, e live continua 200', async () => {
    const previous = process.env.DATABASE_URL;
    // Porta onde ninguém escuta: o caminho real de uma conexão recusada.
    process.env.DATABASE_URL = 'postgresql://wager:wager@127.0.0.1:1/wager';
    const { app, url } = await boot();
    try {
      const t0 = Date.now();
      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable', postgres: 'down', sqs: 'up' });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await app.close().catch(() => {});
    }
  });
});
