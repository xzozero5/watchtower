import { Module } from '@nestjs/common';

import { SlaAdminService } from './sla-admin.service.js';
import { BusinessCalendarsController, SlaPoliciesController } from './sla.controller.js';
import { SlaService } from './sla.service.js';

/** SLA policies, business calendars and the due-date service tickets use (R-1.6). */
@Module({
  controllers: [SlaPoliciesController, BusinessCalendarsController],
  providers: [SlaService, SlaAdminService],
  exports: [SlaService],
})
export class SlaModule {}
