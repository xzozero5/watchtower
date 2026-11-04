import { Module } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { HUMAN_VERIFICATION } from './human-verification.js';
import { PortalController } from './portal.controller.js';
import { PortalAttachmentsService } from './portal-attachments.service.js';
import { PortalLimits } from './portal-limits.js';
import { PortalMyRequestsService } from './portal-my-requests.service.js';
import { PortalUploadInterceptor } from './portal-upload.interceptor.js';
import { PortalUploadQuota } from './portal-upload-quota.js';
import { PortalNotificationsModule } from './portal-notifications.module.js';
import { PortalStaffController } from './portal-staff.controller.js';
import { PortalSubmissionService } from './portal-submission.service.js';
import { PortalTrackingService } from './portal-tracking.service.js';
import { SelfHostedHumanVerificationProvider } from './self-hosted-verification.js';

/**
 * The client portal channel (PRD section 4.9, T-007): the public submit form, the tracking page
 * behind a signed link, replies from that page, and the customer emails that go with them. Human
 * verification is self-hosted (ADR-007); to use a hosted provider replace the class behind
 * `HUMAN_VERIFICATION`.
 */
@Module({
  imports: [OrgsModule, TicketsModule, PortalNotificationsModule],
  controllers: [PortalController, PortalStaffController],
  providers: [
    PortalLimits,
    PortalAttachmentsService,
    PortalUploadQuota,
    PortalUploadInterceptor,
    PortalSubmissionService,
    PortalTrackingService,
    PortalMyRequestsService,
    { provide: HUMAN_VERIFICATION, useClass: SelfHostedHumanVerificationProvider },
  ],
})
export class PortalModule {}
