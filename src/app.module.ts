import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AnonymousIdentity } from './infrastructure/auth/anonymous-identity';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { PROVIDER_IDENTITY } from './infrastructure/tokens';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringModule } from './wagering.module';
import { WorkersModule } from './workers/workers.module';

@Module({
  imports: [DatabaseModule, SqsModule, ObservabilityModule, WageringModule, WorkersModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    // Ponto de extensão da autenticação: troque esta implementação por uma que valide tokens.
    { provide: PROVIDER_IDENTITY, useFactory: () => new AnonymousIdentity() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
