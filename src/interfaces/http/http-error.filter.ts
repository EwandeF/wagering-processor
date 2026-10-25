import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { toHttpError } from './http-error-mapper';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = toHttpError(error);

    if (mapped.status === 500) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`${e.name}: ${e.message}`, e.stack);
    } else if (mapped.status === 503) {
      this.logger.warn(`${mapped.code}: ${mapped.message}`);
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message },
    });
  }
}
