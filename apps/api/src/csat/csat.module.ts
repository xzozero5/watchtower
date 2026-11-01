import { Module } from '@nestjs/common';

import { TicketsModule } from '../tickets/tickets.module.js';
import { CsatLimits } from './csat-limits.js';
import { CsatPublicController } from './csat-public.controller.js';
import { CsatPublicService } from './csat-public.service.js';
import { CsatReader } from './csat-reader.service.js';
import { CsatStaffController } from './csat-staff.controller.js';

/**
 * CSAT surveys (T-110, PRD section 4.10): the public survey page behind a signed single-use link
 * (`GET /v1/csat/survey`, `POST /v1/csat/responses`) and the staff side (results, metrics, the
 * delay setting, per-organization opt-out). Scheduling and sending are the worker's `csat` queue; the
 * rules (when to survey, who to spare, when an answer reopens a ticket) are in `@watchtower/domain`.
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts`.
 */
@Module({
  imports: [TicketsModule],
  controllers: [CsatPublicController, CsatStaffController],
  providers: [CsatLimits, CsatPublicService, CsatReader],
})
export class CsatModule {}
