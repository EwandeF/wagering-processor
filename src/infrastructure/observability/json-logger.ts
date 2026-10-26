import type { LoggerService } from '@nestjs/common';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/**
 * Uma linha de JSON por evento, com os campos do evento no nível principal
 * (correlationId, messageId, transactionId...). Os campos do evento nunca
 * sobrescrevem level, timestamp e context.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    // O Logger do Nest acrescenta o contexto como último parâmetro.
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const stack =
      (level === 'error' || level === 'fatal') && typeof rest[0] === 'string'
        ? (rest[0] as string)
        : undefined;

    let fields: Record<string, unknown>;
    if (message instanceof Error) {
      fields = { msg: message.message, errorName: message.name, stack: message.stack };
    } else if (message !== null && typeof message === 'object') {
      fields = { ...(message as Record<string, unknown>) };
    } else {
      fields = { msg: String(message) };
    }
    if (stack) fields = { ...fields, stack };

    const { level: _l, timestamp: _t, context: _c, ...safe } = fields;
    const base = { level, timestamp: this.now().toISOString(), context };
    try {
      this.write(JSON.stringify({ ...base, ...safe }));
    } catch {
      this.write(JSON.stringify({ ...base, msg: String(message) }));
    }
  }
}
