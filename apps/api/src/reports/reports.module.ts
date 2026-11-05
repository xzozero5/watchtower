import { Module } from '@nestjs/common';

import { AiCostService } from './ai-cost.service.js';
import { CeoViewService } from './ceo-view.service.js';
import { ReportsController } from './reports.controller.js';
import { SeedFilter } from './seed-filter.js';
import { WeeklyBriefController } from './weekly-brief.controller.js';
import { WeeklyBriefService } from './weekly-brief.service.js';

/**
 * Reports for heads and leads (T-305a, T-305b, T-305c): the AI cost dashboard, the CEO view and its pluggable tiles,
 * and the AI-drafted weekly brief. Reads only, except the head's data points for the pluggable tiles and the
 * head's edit and publish of the brief (audited).
 */
@Module({
  controllers: [ReportsController, WeeklyBriefController],
  providers: [AiCostService, CeoViewService, SeedFilter, WeeklyBriefService],
  exports: [SeedFilter, CeoViewService],
})
export class ReportsModule {}
