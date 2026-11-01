import { Module } from '@nestjs/common';

import { DeploysController, IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

/**
 * Incidents and the deploy feed as staff see them (T-202a, R-3.12, R-5.4). The signed route CI posts
 * deploys to lives with the other machine receivers in `AlertsModule`. Every route needs
 * `@RequirePermission` / `@RequireAnyPermission` or `@Public()`.
 */
@Module({
  controllers: [IncidentsController, DeploysController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
