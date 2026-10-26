import type { Subprocess } from 'bun';
import { type E2eQueues, waitFor } from './e2e-helpers';

export interface AppProcess {
  port: number;
  url: string;
  proc: Subprocess;
  /** SIGTERM é o desligamento educado; SIGKILL é a morte súbita, sem nenhuma chance de limpeza. */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port;
  await server.stop(true);
  if (!port) throw new Error('não foi possível reservar uma porta livre');
  return port;
}

/** Sobe um processo de verdade do app, com os workers ligados e as filas do teste. */
export async function spawnApp(queues: E2eQueues): Promise<AppProcess> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(port),
      WORKERS_ENABLED: 'true',
      WAGER_QUEUE_URL: queues.inUrl,
      WAGER_DLQ_URL: queues.dlqUrl,
      EVENTS_QUEUE_URL: queues.eventsUrl,
      OUTBOX_POLL_MS: '100',
      REFERENCE_POLL_MS: '200',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;

  const app: AppProcess = {
    port,
    url,
    proc,
    stop: async (signal = 'SIGTERM') => {
      if (proc.exitCode === null) {
        proc.kill(signal === 'SIGKILL' ? 9 : 15);
      }
      await Promise.race([proc.exited, Bun.sleep(20_000)]);
      if (proc.exitCode === null) {
        proc.kill(9); // o desligamento educado travou: derruba para não deixar processo órfão
        await proc.exited;
      }
    },
  };

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/health/ready`)).status === 200;
      } catch {
        return false;
      }
    }, 30_000);
  } catch (error) {
    await app.stop('SIGKILL');
    throw error;
  }
  return app;
}
