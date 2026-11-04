import { Module } from '@nestjs/common';

import { AiCostService } from './ai-cost.service.js';
import { CeoViewService } from './ceo-view.service.js';
import { ReportsController } from './reports.controller.js';
import { SeedFilter } from './seed-filter.js';

/**
 * Reports for heads and leads (T-305a, T-305b): the AI cost dashboard, the CEO view and its pluggable tiles.
 * Reads only, except the head's data points for the pluggable tiles (audited).
 */
@Module({
  controllers: [ReportsController],
  providers: [AiCostService, CeoViewService, SeedFilter],
  exports: [SeedFilter],
})
export class ReportsModule {}
