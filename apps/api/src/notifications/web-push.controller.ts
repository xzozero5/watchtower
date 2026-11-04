import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  webPushStatusSchema,
  webPushSubscribeSchema,
  webPushUnsubscribeSchema,
  type WebPushSubscribe,
  type WebPushUnsubscribe,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { WebPushService } from './web-push.service.js';

/**
 * The caller's own Web Push subscriptions (T-105). Staff only (`ticket.read`, like the notification
 * center). The subscription endpoint is never returned and never audited: only the fact that it changed.
 */
@ApiTags('notifications')
@Controller('v1/notifications/push')
export class WebPushController {
  constructor(@Inject(WebPushService) private readonly webPush: WebPushService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'Is Web Push on, the public key to subscribe with, how many of my browsers (staff)',
    description:
      '`enabled: false` and `publicKey: null` when the VAPID credential is not complete: the app then does not offer it.',
  })
  @ApiOkResponse({ standardSchema: webPushStatusSchema })
  async status(@CurrentPrincipal() principal: Principal) {
    return parseResponse(webPushStatusSchema, await this.webPush.status(principal.userId));
  }

  @Post('subscriptions')
  @HttpCode(200)
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.webPushSubscribed, targetType: 'web_push_subscription' })
  @ApiOperation({
    summary: "Save this browser's push subscription (staff)",
    description:
      'Takes `PushSubscription.toJSON()`. Refused (400) when the push service is not one of the supported ones ' +
      '(Chrome/Edge, Firefox, Safari), 409 when Web Push is not set up on the server.',
  })
  @ApiOkResponse({ standardSchema: webPushStatusSchema })
  @ApiBadRequestResponse({ description: 'Unsupported push service or invalid keys' })
  @ApiConflictResponse({ description: 'Web Push is not set up on this server' })
  async subscribe(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: webPushSubscribeSchema }) body: WebPushSubscribe,
  ) {
    return parseResponse(webPushStatusSchema, await this.webPush.subscribe(principal.userId, body));
  }

  @Delete('subscriptions')
  @HttpCode(200)
  @RequirePermission('ticket.read')
  @Audited({ action: AUDIT_ACTIONS.webPushUnsubscribed, targetType: 'web_push_subscription' })
  @ApiOperation({ summary: "Remove this browser's push subscription (staff)" })
  @ApiOkResponse({ standardSchema: webPushStatusSchema })
  async unsubscribe(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: webPushUnsubscribeSchema }) body: WebPushUnsubscribe,
  ) {
    return parseResponse(
      webPushStatusSchema,
      await this.webPush.unsubscribe(principal.userId, body.endpoint),
    );
  }
}
