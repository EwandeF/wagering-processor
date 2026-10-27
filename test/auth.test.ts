import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import type {
  ProviderIdentity,
  ProviderIdentityPort,
  RequestCredentials,
} from '../src/application/identity';
import { AnonymousIdentity } from '../src/infrastructure/auth/anonymous-identity';
import { PROVIDER_IDENTITY } from '../src/infrastructure/tokens';
import { assertProviderAccess, ownsTransaction } from '../src/interfaces/http/access';
import { ForbiddenError } from '../src/interfaces/http/http-errors';
import { uid } from './helpers';

/** Identidade falsa: uma tabela de tokens. Não valida assinatura de nada. */
class FakeIdentity implements ProviderIdentityPort {
  private readonly tokens: Record<string, ProviderIdentity> = {
    'token-a': { subject: 'svc-a', providerId: 'provider-a' },
    'token-b': { subject: 'svc-b', providerId: 'provider-b' },
    'token-admin': { subject: 'admin' },
  };
  async identify(credentials: RequestCredentials): Promise<ProviderIdentity | undefined> {
    const match = credentials.authorization?.match(/^Bearer (.+)$/);
    return match ? this.tokens[match[1]!] : undefined;
  }
}

describe('decisões de acesso por provedor', () => {
  const free: ProviderIdentity = { subject: 'admin' };
  const a: ProviderIdentity = { subject: 'svc-a', providerId: 'provider-a' };

  test('sem restrição de provedor, atua em qualquer um', () => {
    expect(() => assertProviderAccess(free, 'provider-x')).not.toThrow();
    expect(ownsTransaction(free, 'provider-x')).toBe(true);
  });

  test('restrita: atua no próprio provedor e é barrada nos outros', () => {
    expect(() => assertProviderAccess(a, 'provider-a')).not.toThrow();
    expect(() => assertProviderAccess(a, 'provider-b')).toThrow(ForbiddenError);
  });

  test('restrita: só é dona das transações do próprio provedor', () => {
    expect(ownsTransaction(a, 'provider-a')).toBe(true);
    expect(ownsTransaction(a, 'provider-b')).toBe(false);
  });

  test('a implementação padrão libera tudo e não restringe provedor', async () => {
    expect(await new AnonymousIdentity().identify()).toEqual({ subject: 'anonymous' });
  });
});

describe('HTTP com uma identidade restrita por provedor', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PROVIDER_IDENTITY)
      .useValue(new FakeIdentity())
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (
    path: string,
    opts: { method?: string; token?: string; auth?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${url}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.auth ? { authorization: opts.auth } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  const money = (amount: string) => ({ amount, currency: 'BRL' });

  async function newWallet() {
    const res = await call('/wallets', {
      method: 'POST', token: 'token-admin',
      body: { playerId: uid(), initialBalance: money('100.00') },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; playerId: string };
  }

  type W = Awaited<ReturnType<typeof newWallet>>;

  function submit(w: W, providerId: string, ext: string, token?: string) {
    return call('/wagering/transactions', {
      method: 'POST', token, headers: { 'idempotency-key': `${providerId}:${ext}` },
      body: {
        providerId, externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
        roundId: 'r1', gameId: 'g1', kind: 'BET', money: money('10.00'),
      },
    });
  }

  test('health e metrics continuam abertos, sem credenciais', async () => {
    expect((await call('/health/live')).status).toBe(200);
    expect((await call('/health/ready')).status).toBe(200);
    expect((await call('/metrics')).status).toBe(200);
  });

  test('sem credenciais: 401 no formato padrão e com WWW-Authenticate', async () => {
    const res = await call('/wallets', {
      method: 'POST', body: { playerId: uid(), initialBalance: money('1.00') },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  test('token desconhecido e esquema errado também são 401', async () => {
    const wallet = await newWallet();
    expect((await call(`/wallets/${wallet.id}`, { token: 'token-que-nao-existe' })).status).toBe(401);
    expect((await call(`/wallets/${wallet.id}`, { auth: 'Basic YWRtaW46YWRtaW4=' })).status).toBe(401);
  });

  test('os endpoints de wallet exigem autenticação', async () => {
    const wallet = await newWallet();
    expect((await call(`/wallets/${wallet.id}`)).status).toBe(401);
    expect((await call(`/wallets/${wallet.id}/ledger`)).status).toBe(401);
    expect((await call(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).status).toBe(401);
  });

  test('uma identidade restrita a um provedor ainda lê wallets (a wallet é do jogador, não do provedor)', async () => {
    const wallet = await newWallet();
    expect((await call(`/wallets/${wallet.id}`, { token: 'token-a' })).status).toBe(200);
  });

  test('uma identidade restrita submete no próprio provedor', async () => {
    const wallet = await newWallet();
    const res = await submit(wallet, 'provider-a', uid(), 'token-a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { balance: { amount: string } }).balance.amount).toBe('90.00');
  });

  test('submeter em nome de outro provedor: 403 e nenhum efeito', async () => {
    const wallet = await newWallet();
    const ext = uid();
    const res = await submit(wallet, 'provider-b', ext, 'token-a');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const after = (await (await call(`/wallets/${wallet.id}`, { token: 'token-admin' })).json()) as {
      balance: { amount: string }; version: number;
    };
    expect(after.balance.amount).toBe('100.00');
    expect(after.version).toBe(1);
    expect((await call(`/providers/provider-b/wagering/transactions/${ext}`, { token: 'token-admin' })).status).toBe(404);
  });

  test('consultar por provedor e id externo de outro provedor: 403', async () => {
    const wallet = await newWallet();
    const ext = uid();
    expect((await submit(wallet, 'provider-b', ext, 'token-admin')).status).toBe(200);
    expect((await call(`/providers/provider-b/wagering/transactions/${ext}`, { token: 'token-a' })).status).toBe(403);
    expect((await call(`/providers/provider-b/wagering/transactions/${ext}`, { token: 'token-b' })).status).toBe(200);
  });

  test('consultar por id interno uma transação de outro provedor: 404, sem revelar que existe', async () => {
    const wallet = await newWallet();
    const created = (await (await submit(wallet, 'provider-b', uid(), 'token-admin')).json()) as {
      transactionId: string;
    };
    const foreign = await call(`/wagering/transactions/${created.transactionId}`, { token: 'token-a' });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await call(`/wagering/transactions/${created.transactionId}`, { token: 'token-b' })).status).toBe(200);
  });

  test('uma requisição sem credenciais não produz efeito nenhum', async () => {
    const wallet = await newWallet();
    const ext = uid();
    expect((await submit(wallet, 'provider-a', ext)).status).toBe(401);
    const after = (await (await call(`/wallets/${wallet.id}`, { token: 'token-admin' })).json()) as {
      balance: { amount: string };
    };
    expect(after.balance.amount).toBe('100.00');
    expect((await call(`/providers/provider-a/wagering/transactions/${ext}`, { token: 'token-admin' })).status).toBe(404);
  });
});
