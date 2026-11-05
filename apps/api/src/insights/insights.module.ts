import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { IntentsModule } from '../intents/intents.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { InsightAccess } from './insight-access.js';
import { InsightMarks } from './insight-marks.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

/**
 * Embedded insights (T-416, ADR-029 section 9): `GET /v1/insights`. `InsightAccess` is exported so that another
 * module (the feedback of T-408) asks the same `canViewInsight` before it accepts anything about an insight.
 */
@Module({
  imports: [AiModule, IncidentsModule, IntentsModule, OrgsModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightAccess, InsightMarks],
  exports: [InsightAccess],
})
export class InsightsModule {}
