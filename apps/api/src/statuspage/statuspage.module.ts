import { Module } from '@nestjs/common';

import { HUMAN_VERIFICATION } from '../portal/human-verification.js';
import { SelfHostedHumanVerificationProvider } from '../portal/self-hosted-verification.js';
import { StatusAdminController } from './status-admin.controller.js';
import { StatusAdminService } from './status-admin.service.js';
import { StatusPagePublicGuard } from './status-page.guard.js';
import { StatusLimits } from './status-limits.js';
import {
  StatusPublicController,
  StatusSubscriptionsController,
} from './status-public.controller.js';
import { StatusPublicService } from './status-public.service.js';

/**
 * The status page (T-204, PRD section 4.6): the public page and its email subscriptions
 * (`/v1/status`, closed with 404 unless `STATUS_PAGE_PUBLIC=true`) and the staff side that drafts and
 * publishes (`/v1/status-page`). Publishing is a person's act (N3). Sending the confirmation and the
 * notices is the worker's `statuspage` queue. Every route needs `@RequirePermission` /
 * `@RequireAnyPermission` or `@Public()`, and a public one must also be listed in `./public-routes.ts`.
 */
@Module({
  controllers: [StatusPublicController, StatusSubscriptionsController, StatusAdminController],
  providers: [
    StatusPagePublicGuard,
    StatusLimits,
    StatusPublicService,
    StatusAdminService,
    // The same proof of work as the portal (ADR-007, T-207a C-3): the page mails an address a stranger typed.
    { provide: HUMAN_VERIFICATION, useClass: SelfHostedHumanVerificationProvider },
  ],
  // T-402: the assistant reads components, drafts and maintenance windows through the staff service.
  exports: [StatusAdminService],
})
export class StatusPageModule {}
