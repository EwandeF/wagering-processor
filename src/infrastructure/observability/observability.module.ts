import { Global, Module } from '@nestjs/common';
import { MetricsController } from '../../interfaces/http/metrics.controller';
import { Metrics } from './metrics';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [Metrics],
  exports: [Metrics],
})
export class ObservabilityModule {}
