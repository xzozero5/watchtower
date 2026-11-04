import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { ShiftAlertsService } from './shift-alerts.service.js';
import { WebPushController } from './web-push.controller.js';
import { WebPushService } from './web-push.service.js';

/**
 * In-app notifications and preferences (T-105, R-3.16). Ticket alerts (P1, assigned) are raised by
 * the domain inside the ticket operations; this module reads them for the caller, marks them read,
 * keeps the preferences, keeps the caller's Web Push subscriptions (the worker sends the pushes), and
 * exports `ShiftAlertsService` for T-111 (lead alerts). Every route needs `@RequirePermission`
 * / `@RequireAnyPermission` or `@Public()`.
 */
@Module({
  imports: [TicketsModule, CredentialsModule],
  controllers: [NotificationsController, WebPushController],
  providers: [NotificationsService, ShiftAlertsService, WebPushService],
  exports: [NotificationsService, ShiftAlertsService],
})
export class NotificationsModule {}
