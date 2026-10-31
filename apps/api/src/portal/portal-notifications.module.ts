import { Module } from '@nestjs/common';

import { PortalNotifier } from './portal-notifier.js';
import { PortalTokensService } from './portal-tokens.service.js';

/**
 * Tracking tokens and the customer emails of the portal. Split from `PortalModule` so that
 * `TicketsModule` can write these emails in the transaction of a reply, a status change or a merge
 * without a circular import (the portal controllers import `TicketsModule`).
 */
@Module({
  providers: [PortalTokensService, PortalNotifier],
  exports: [PortalTokensService, PortalNotifier],
})
export class PortalNotificationsModule {}
