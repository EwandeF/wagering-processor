import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './infrastructure/observability/json-logger';

// Logs em JSON, uma linha por evento, prontos para qualquer coletor.
const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
