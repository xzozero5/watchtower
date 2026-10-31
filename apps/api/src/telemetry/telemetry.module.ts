import { Global, Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller.js';
import { TelemetryService } from './telemetry.service.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
