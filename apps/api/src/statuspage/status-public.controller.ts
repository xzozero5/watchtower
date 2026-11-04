import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
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
  humanChallengeSchema,
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
import { z } from 'zod';

import { Audited, Public } from '../auth/decorators.js';
import { ApiHttpError } from '../auth/http-errors.js';
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
    description:
      'Published posts of the last 90 days and the published maintenance windows that ended in them.',
  })
  @ApiOkResponse({ standardSchema: publicHistorySchema })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async history(@Req() request: Request) {
    return parseResponse(publicHistorySchema, await this.service.history(request.ip ?? null));
  }
}

/** RFC 8058: the body a mail client sends to a `List-Unsubscribe` URL. */
const oneClickBodySchema = z.object({ 'List-Unsubscribe': z.literal('One-Click') });

/** The subscription routes, no-store like the other public pages that take a link. */
@ApiTags('status page')
@Controller('v1/status/subscriptions')
@UseGuards(StatusPagePublicGuard)
@UseInterceptors(PortalHeadersInterceptor)
export class StatusSubscriptionsController {
  constructor(@Inject(StatusPublicService) private readonly service: StatusPublicService) {}

  @Get('challenge')
  @Public()
  @ApiOperation({
    summary: 'Human-verification challenge for the subscribe form',
    description:
      'Public. The same signed proof-of-work challenge as the portal (ADR-007): find a decimal `nonce` so that ' +
      'SHA-256 of the UTF-8 text `<challenge>:<nonce>` has at least `difficultyBits` leading zero bits, and send ' +
      'it as `verification` with the subscribe request, not sooner than `minFillSeconds` after `issuedAt`. ' +
      'A solved challenge works once. Limited per IP (IPv6 by /64).',
  })
  @ApiOkResponse({ standardSchema: humanChallengeSchema })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many challenges from this IP address' })
  async challenge(@Req() request: Request) {
    return parseResponse(humanChallengeSchema, await this.service.challenge(request.ip ?? null));
  }

  @Post()
  @Public()
  @HttpCode(202)
  @Audited({
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionRequest,
    targetType: 'status_subscription',
  })
  @ApiOperation({
    summary: 'Ask to be told about the status page',
    description:
      'Sends a confirmation email to the address (double opt-in): nothing is sent to anyone else and ' +
      'nobody is subscribed until the owner of the address follows the link. The answer is the same ' +
      'whether or not the address is known. Needs a solved proof-of-work challenge (`verification`, from ' +
      '`GET /v1/status/subscriptions/challenge`; a failure is 400 `verification_failed`). Limited per IP ' +
      '(5 an hour; IPv6 by /64), per address (3 an hour), per receiving domain, and for the whole page ' +
      '(per hour and per day; reaching those is logged as an error).',
  })
  @ApiOkResponse({ standardSchema: subscribeResultSchema })
  @ApiBadRequestResponse({ description: 'Not an email address, or verification_failed' })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit (status_subscription.rate_limited is audited)',
  })
  async subscribe(@Body({ schema: subscribeSchema }) body: Subscribe, @Req() request: Request) {
    await this.service.subscribe(body, request.ip ?? null);
    return parseResponse(subscribeResultSchema, { status: 'check_your_email' });
  }

  @Post('confirm')
  @Public()
  @HttpCode(200)
  @Audited({
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionConfirm,
    targetType: 'status_subscription',
  })
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

  @Post('unsubscribe/one-click')
  @Public()
  @HttpCode(200)
  @Audited({
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionUnsubscribe,
    targetType: 'status_subscription',
  })
  @ApiOperation({
    summary: 'Unsubscribe in one click (RFC 8058)',
    description:
      'The URL of the `List-Unsubscribe` header of every notice. A mail client POSTs ' +
      '`List-Unsubscribe=One-Click` (form encoded) to it; the signed unsubscribe token is in the query because ' +
      'the protocol allows nothing else. The token only ever unsubscribes (a confirm token is refused). ' +
      'Idempotent.',
  })
  @ApiOkResponse({ standardSchema: subscriptionResultSchema })
  @ApiBadRequestResponse({ description: 'invalid_or_expired_link, or not a one-click post' })
  @ApiNotFoundResponse({ description: 'The status page is closed' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async unsubscribeOneClick(
    @Query('token') token: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const parsed = subscriptionTokenSchema.safeParse({ token });
    if (!parsed.success || !oneClickBodySchema.safeParse(body).success) {
      throw new ApiHttpError(400, 'invalid_or_expired_link', 'This link is invalid or has expired');
    }
    await this.service.unsubscribe(parsed.data.token, request.ip ?? null);
    return parseResponse(subscriptionResultSchema, { status: 'unsubscribed' });
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
