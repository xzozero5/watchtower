import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  STATUSPAGE_AUDIT_ACTIONS,
  publicHistorySchema,
  publicStatusSchema,
  subscribeResultSchema,
  subscribeSchema,
  subscriptionResultSchema,
  subscriptionTokenSchema,
  type Subscribe,
  type SubscriptionToken,
} from '@watchtower/shared';
import type { Request } from 'express';

import { Audited, Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { PortalHeadersInterceptor } from '../portal/portal-headers.interceptor.js';
import { StatusPagePublicGuard } from './status-page.guard.js';
import { StatusPublicService } from './status-public.service.js';

/**
 * The public status page (PRD R-6.1, R-6.2, T-204). No session and no cookie, so there is no ambient
 * authority for CSRF to borrow; the only credential anywhere is the signed link of a subscription, which
 * travels in the BODY of a POST (the page reads it from the URL fragment), never in a URL.
 *
 * Closed by default: unless `STATUS_PAGE_PUBLIC=true` every route here answers 404 (the guard).
 *
 * The answers are allow-lists (see `publicStatusSchema`): components flagged public, posts and windows a
 * person published, and nothing about the incident behind a post. The subscribe route answers the same
 * thing for every address.
 */
@ApiTags('status page')
@Controller('v1/status')
@UseGuards(StatusPagePublicGuard)
export class StatusPublicController {
  constructor(@Inject(StatusPublicService) private readonly service: StatusPublicService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'public, max-age=15')
  @ApiOperation({
    summary: 'Current status',
    description:
      'Public components with their status, the published posts that are not resolved, and the ' +
      'published maintenance windows that are ongoing or upcoming. 404 when the page is closed. Limited per IP.',
  })
  @ApiOkResponse({ standardSchema: publicStatusSchema })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async current(@Req() request: Request) {
    return parseResponse(publicStatusSchema, await this.service.current(request.ip ?? null));
  }

  @Get('history')
  @Public()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'The last 90 days',
    description: 'Published posts of the last 90 days and the published maintenance windows that ended in them.',
  })
  @ApiOkResponse({ standardSchema: publicHistorySchema })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async history(@Req() request: Request) {
    return parseResponse(publicHistorySchema, await this.service.history(request.ip ?? null));
  }
}

/** The subscription routes, no-store like the other public pages that take a link. */
@ApiTags('status page')
@Controller('v1/status/subscriptions')
@UseGuards(StatusPagePublicGuard)
@UseInterceptors(PortalHeadersInterceptor)
export class StatusSubscriptionsController {
  constructor(@Inject(StatusPublicService) private readonly service: StatusPublicService) {}

  @Post()
  @Public()
  @HttpCode(202)
  @Audited({ action: STATUSPAGE_AUDIT_ACTIONS.subscriptionRequest, targetType: 'status_subscription' })
  @ApiOperation({
    summary: 'Ask to be told about the status page',
    description:
      'Sends a confirmation email to the address (double opt-in): nothing is sent to anyone else and ' +
      'nobody is subscribed until the owner of the address follows the link. The answer is the same ' +
      'whether or not the address is known. Limited per IP (5 an hour) and per address (3 an hour).',
  })
  @ApiOkResponse({ standardSchema: subscribeResultSchema })
  @ApiBadRequestResponse({ description: 'Not an email address' })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit (status_subscription.rate_limited is audited)' })
  async subscribe(@Body({ schema: subscribeSchema }) body: Subscribe, @Req() request: Request) {
    await this.service.subscribe(body, request.ip ?? null);
    return parseResponse(subscribeResultSchema, { status: 'check_your_email' });
  }

  @Post('confirm')
  @Public()
  @HttpCode(200)
  @Audited({ action: STATUSPAGE_AUDIT_ACTIONS.subscriptionConfirm, targetType: 'status_subscription' })
  @ApiOperation({
    summary: 'Confirm a subscription',
    description:
      'The signed token of the confirmation email, in the body. A POST on purpose: a mail scanner that ' +
      'opens every link in an email does not confirm anything. Following it twice is harmless.',
  })
  @ApiOkResponse({ standardSchema: subscriptionResultSchema })
  @ApiBadRequestResponse({ description: 'invalid_or_expired_link' })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async confirm(
    @Body({ schema: subscriptionTokenSchema }) body: SubscriptionToken,
    @Req() request: Request,
  ) {
    await this.service.confirm(body.token, request.ip ?? null);
    return parseResponse(subscriptionResultSchema, { status: 'confirmed' });
  }

  @Post('unsubscribe')
  @Public()
  @HttpCode(200)
  @Audited({
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionUnsubscribe,
    targetType: 'status_subscription',
  })
  @ApiOperation({
    summary: 'Unsubscribe',
    description: 'The signed token that every email carries, in the body. Idempotent.',
  })
  @ApiOkResponse({ standardSchema: subscriptionResultSchema })
  @ApiBadRequestResponse({ description: 'invalid_or_expired_link' })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async unsubscribe(
    @Body({ schema: subscriptionTokenSchema }) body: SubscriptionToken,
    @Req() request: Request,
  ) {
    await this.service.unsubscribe(body.token, request.ip ?? null);
    return parseResponse(subscriptionResultSchema, { status: 'unsubscribed' });
  }
}
