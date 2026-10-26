import type { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Module } from '@nestjs/common';
import { MetricsController } from '../../interfaces/http/metrics.controller';
import { MikroOutboxProbe } from '../persistence/mikro-outbox-probe';
import { ORM } from '../tokens';
import { Metrics } from './metrics';
import { WagerTelemetry } from './wager-telemetry';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    Metrics,
    { provide: WagerTelemetry, useFactory: (m: Metrics) => new WagerTelemetry(m), inject: [Metrics] },
  ],
  exports: [Metrics, WagerTelemetry],
})
export class ObservabilityModule {
  constructor(
    @Inject(Metrics) metrics: Metrics,
    @Inject(ORM) orm: MikroORM,
  ) {
    metrics.bindOutboxProbe(new MikroOutboxProbe(orm).read);
  }
}
