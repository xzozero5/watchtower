import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  idParamSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationReadAllResultSchema,
  setNotificationPreferencesSchema,
  type NotificationListQuery,
  type SetNotificationPreferences,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { NotificationsService } from './notifications.service.js';

type IdParam = z.infer<typeof idParamSchema>;

/**
 * The caller's own notifications (R-3.16, in-app). Staff only: `ticket.read` is held by agent, lead
 * and head and by no client, so a client user is refused (403) and never sees anything internal.
 * There is no way to read or mark another person's notification.
 */
@ApiTags('notifications')
@Controller('v1/notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'My notifications, newest first (staff)',
    description:
      'Keyset-paginated: pass `nextCursor` back as `cursor`. `unreadCount` counts every unread one, ' +
      'not only this page. The ticket subject is read from the ticket now, not copied.',
  })
  @ApiOkResponse({ standardSchema: notificationPageSchema })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: notificationListQuerySchema }) query: NotificationListQuery,
  ) {
    return parseResponse(
      notificationPageSchema,
      await this.notifications.list(principal.userId, query),
    );
  }

  @Get('preferences')
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'My notification preferences (staff)',
    description: 'Every kind is listed; a kind with `mandatory: true` cannot be turned off.',
  })
  @ApiOkResponse({ standardSchema: notificationPreferencesSchema })
  async preferences(@CurrentPrincipal() principal: Principal) {
    return parseResponse(
      notificationPreferencesSchema,
      await this.notifications.preferences(principal.userId),
    );
  }

  @Put('preferences')
  @RequirePermission('ticket.read')
  @Audited({
    action: AUDIT_ACTIONS.notificationPreferencesSet,
    targetType: 'notification_preference',
  })
  @ApiOperation({
    summary: 'Set my notification preferences (staff)',
    description: 'Only the kinds in the body change. Turning off `ticket.p1` is refused with 400.',
  })
  @ApiOkResponse({ standardSchema: notificationPreferencesSchema })
  async setPreferences(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: setNotificationPreferencesSchema }) body: SetNotificationPreferences,
  ) {
    return parseResponse(
      notificationPreferencesSchema,
      await this.notifications.setPreferences(principal.userId, body),
    );
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.notificationReadAll, targetType: 'notification' })
  @ApiOperation({ summary: 'Mark all my notifications read (staff)' })
  @ApiOkResponse({ standardSchema: notificationReadAllResultSchema })
  async readAll(@CurrentPrincipal() principal: Principal) {
    return parseResponse(notificationReadAllResultSchema, {
      updated: await this.notifications.markAllRead(principal.userId),
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.notificationRead, targetType: 'notification' })
  @ApiOperation({ summary: 'Mark one of my notifications read (staff)' })
  @ApiNoContentResponse({ description: 'Marked read (also when it already was)' })
  @ApiNotFoundResponse({ description: 'No such notification of mine' })
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param({ schema: idParamSchema }) params: IdParam,
  ): Promise<void> {
    await this.notifications.markRead(principal.userId, params.id);
  }
}
