export interface PollingLoopOptions {
  name: string;
  /** Espera entre rodadas quando não havia nada a fazer (ou quando a rodada falhou). */
  intervalMs: number;
  /** Faz uma rodada de trabalho e devolve quantos itens tratou. */
  tick: () => Promise<number>;
  onError?: (name: string, error: unknown) => void;
}

/**
 * Repete `tick`: se a rodada tratou algo, repete na hora (esvazia o backlog);
 * se não tratou nada, ou falhou, dorme `intervalMs`. `stop()` acorda o sono
 * e espera a rodada em andamento terminar.
 */
export class PollingLoop {
  private stopping = false;
  private running?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly options: PollingLoopOptions) {}

  start(): void {
    if (!this.running && !this.stopping) {
      this.running = this.loop();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let worked = 0;
      try {
        worked = await this.options.tick();
      } catch (error) {
        this.report(error);
      }
      if (worked === 0 && !this.stopping) {
        await this.sleep();
      }
    }
  }

  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.options.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(this.options.name, error);
    } catch {
      // Um observador com defeito não pode derrubar o laço.
    }
  }
}
