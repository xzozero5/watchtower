import { Module } from '@nestjs/common';

import { TicketsModule } from '../tickets/tickets.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { ShiftAlertsService } from './shift-alerts.service.js';

/**
 * In-app notifications and preferences (T-105, R-3.16). Ticket alerts (P1, assigned) are raised by
 * the domain inside the ticket operations; this module reads them for the caller, marks them read,
 * keeps the preferences, and exports `ShiftAlertsService` for T-111 (lead alerts). Web Push, the
 * focus digest and sound come after T-113. Every route needs `@RequirePermission`
 * / `@RequireAnyPermission` or `@Public()`.
 */
@Module({
  imports: [TicketsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, ShiftAlertsService],
  exports: [NotificationsService, ShiftAlertsService],
})
export class NotificationsModule {}
