import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/decorators.js';
import { GmailPushService } from './gmail-push.service.js';

/**
 * `POST /v1/inbound/gmail/push`: where Pub/Sub delivers Gmail notifications (T-102b). Public in the
 * sense that it has no session; it authenticates every request with the OIDC token Pub/Sub signs
 * (see `GmailPushService`). The body is deliberately not validated by a pipe: a message that
 * passed authentication but cannot be read must be acknowledged, not rejected (poison message).
 */
@ApiTags('inbound')
@Controller('v1/inbound/gmail')
export class GmailPushController {
  constructor(@Inject(GmailPushService) private readonly push: GmailPushService) {}

  @Post('push')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Gmail push notification from Pub/Sub',
    description:
      'Called by Pub/Sub only. Needs `Authorization: Bearer <OIDC token>` signed by the push service ' +
      'account of the subscription for the configured audience. Records that the mailbox is alive and ' +
      'queues a history sync; answers 204 (acknowledged) for new, repeated and unprocessable ' +
      'notifications alike. 401 for a bad token (nothing is written), 429 over the per-IP limit, ' +
      '503 when push authentication is not configured or Google keys cannot be fetched.',
  })
  @ApiNoContentResponse({ description: 'Acknowledged' })
  @ApiUnauthorizedResponse({ description: 'Token missing or invalid' })
  @ApiTooManyRequestsResponse({ description: 'Per-IP rate limit' })
  @ApiServiceUnavailableResponse({ description: 'Not configured, or keys unavailable' })
  async receive(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<void> {
    await this.push.accept({ authorization, body, ip: request.ip ?? null });
  }
}
