import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringModule } from './wagering.module';
import { WorkersModule } from './workers/workers.module';

@Module({
  imports: [DatabaseModule, SqsModule, ObservabilityModule, WageringModule, WorkersModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule {}
