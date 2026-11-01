import { Module } from '@nestjs/common';

import { OrgHealthController, UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/**
 * Product usage metrics, anomalies and the Client Health Score as staff see them (T-205). The scheduler that
 * reads the product data and the daily score are the worker's `usage` queue; this module only reads the
 * cached results and lets a head define metrics. Every route needs `@RequirePermission` /
 * `@RequireAnyPermission` or `@Public()`; there are no public routes here.
 */
@Module({
  controllers: [UsageController, OrgHealthController],
  providers: [UsageService],
})
export class UsageModule {}
