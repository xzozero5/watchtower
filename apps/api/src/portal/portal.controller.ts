import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  PORTAL_TOKEN_HEADER,
  humanChallengeSchema,
  portalAcceptedSchema,
  portalReplyResultSchema,
  portalReplySchema,
  portalResendSchema,
  portalSubmitSchema,
  portalSubmittedSchema,
  portalTicketKeyParamSchema,
  portalTicketViewSchema,
  type PortalReply,
  type PortalResend,
  type PortalSubmit,
} from '@watchtower/shared';
import type { Request } from 'express';
import type { z } from 'zod';

import { Audited, Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { HUMAN_VERIFICATION, type HumanVerificationProvider } from './human-verification.js';
import { PortalHeadersInterceptor } from './portal-headers.interceptor.js';
import { PortalLimits } from './portal-limits.js';
import { PortalSubmissionService } from './portal-submission.service.js';
import { PortalTrackingService } from './portal-tracking.service.js';

type KeyParam = z.infer<typeof portalTicketKeyParamSchema>;

const tokenHeader = ApiHeader({
  name: PORTAL_TOKEN_HEADER,
  required: true,
  description:
    'The tracking token from the emailed link (`#token=...` in the URL fragment). Sent by the page ' +
    'in this header; never in a URL, a query string or a cookie.',
});

/**
 * The public client portal (PRD section 4.9, T-007, ADR-007). No session and no cookie: submitting
 * needs a solved proof-of-work challenge, and everything about an existing ticket needs the
 * tracking token in `X-Portal-Token`. Because nothing here is authorised by a cookie a browser
 * attaches by itself, there is no ambient authority for CSRF to borrow; the API-wide Origin check
 * and the single-origin CORS allow-list still apply.
 *
 * Browser contract (for the web pages):
 *  1. Opening the form: `GET /challenge`, solve it in a Web Worker, keep it until submit
 *     (at least `minFillSeconds` after `issuedAt`). Send an empty `website` honeypot field.
 *  2. Submit: `POST /tickets`. On 400 `verification_failed` or 429 start again with a new challenge.
 *     The confirmation page shows `ticketKey`, `maskedEmail` and `expectedFirstResponseAt`.
 *  3. The emailed link is `/portal/tickets/<key>#token=<token>`. The page reads the fragment, removes
 *     it from the address bar (`history.replaceState`), keeps the token in memory or sessionStorage,
 *     and sends it as `X-Portal-Token` on `GET /tickets/<key>` and `POST /tickets/<key>/replies`.
 *  4. 401 `invalid_or_expired_link` on a read: show the "link expired" screen, which calls
 *     `POST /track/resend` with the ticket number and email (answer is the same either way).
 */
@ApiTags('portal')
@Controller('v1/portal')
@UseInterceptors(PortalHeadersInterceptor)
export class PortalController {
  constructor(
    @Inject(HUMAN_VERIFICATION) private readonly verification: HumanVerificationProvider,
    @Inject(PortalLimits) private readonly limits: PortalLimits,
    @Inject(PortalSubmissionService) private readonly submissions: PortalSubmissionService,
    @Inject(PortalTrackingService) private readonly tracking: PortalTrackingService,
  ) {}

  @Get('challenge')
  @Public()
  @ApiOperation({
    summary: 'Human-verification challenge for the submit form',
    description:
      'Public. A signed, stateless proof-of-work challenge (ADR-007): find a decimal `nonce` so that ' +
      'SHA-256 of the UTF-8 text `<challenge>:<nonce>` has at least `difficultyBits` leading zero ' +
      'bits. Ask for it when the form opens: the submit is refused sooner than `minFillSeconds` ' +
      'after `issuedAt`. A solved challenge works once.',
  })
  @ApiOkResponse({ standardSchema: humanChallengeSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many challenges from this IP address' })
  async challenge(@Req() request: Request) {
    await this.limits.enforce('challenge-ip', request.ip ?? 'unknown');
    return parseResponse(humanChallengeSchema, await this.verification.challenge());
  }

  @Post('tickets')
  @Public()
  @Audited({ action: AUDIT_ACTIONS.portalTicketSubmit, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Submit a request without signing in',
    description:
      'Creates a ticket on the `portal` channel, finds or creates the contact, files it under the ' +
      'organization that claimed the email domain (else an "unmatched" organization for triage, with ' +
      'the typed organization kept in `customFields.portal`), maps `category` to an intent hint and ' +
      '`urgency` to a priority `[ASSUMED]`, computes the SLA, and queues the confirmation email. ' +
      'The tracking link is only in that email. Attachments are not accepted yet (T-102): an ' +
      'unknown field such as `attachments` is a 400. Limited per IP, per email and per organization ' +
      '(429 with Retry-After); a failed verification is 400 `verification_failed`.',
  })
  @ApiCreatedResponse({ standardSchema: portalSubmittedSchema })
  @ApiBadRequestResponse({ description: 'Invalid form, or verification_failed' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit (portal.rate_limited is audited)' })
  async submit(@Body({ schema: portalSubmitSchema }) body: PortalSubmit, @Req() request: Request) {
    return parseResponse(
      portalSubmittedSchema,
      await this.submissions.submit(body, { ip: request.ip ?? null }),
    );
  }

  @Get('tickets/:key')
  @Public()
  @tokenHeader
  @ApiOperation({
    summary: 'The public side of a ticket, for its tracking link',
    description:
      'Status in the customer words (Received / In progress / Waiting for your reply / Resolved / ' +
      'Closed / Merged into <key>), the public timeline (customer messages, replies from the team ' +
      'with the first name of the agent, status changes), whether a reply is possible, and when the ' +
      'link expires. Never internal notes, AI or system events, assignment or SLA internals. A ' +
      'missing, wrong, expired or revoked token, an unknown ticket number and a token of another ' +
      'ticket all answer the same 401.',
  })
  @ApiOkResponse({ standardSchema: portalTicketViewSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async view(
    @Param({ schema: portalTicketKeyParamSchema }) params: KeyParam,
    @Headers(PORTAL_TOKEN_HEADER) token: string | undefined,
    @Req() request: Request,
  ) {
    return parseResponse(
      portalTicketViewSchema,
      await this.tracking.view(token, params.key, request.ip ?? null),
    );
  }

  @Post('tickets/:key/replies')
  @Public()
  @tokenHeader
  @Audited({ action: AUDIT_ACTIONS.ticketReply, targetType: 'ticket' })
  @ApiOperation({
    summary: 'Answer from the tracking page',
    description:
      'Adds a customer message to the timeline of the ticket. A ticket that waits on the customer ' +
      'goes back to work, and one resolved in the last 7 days reopens (the same rules as a reply ' +
      'from a signed-in client). Closed and merged tickets answer 409 `ticket_not_open`. Limited ' +
      'per IP and per ticket.',
  })
  @ApiCreatedResponse({ standardSchema: portalReplyResultSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit' })
  async reply(
    @Param({ schema: portalTicketKeyParamSchema }) params: KeyParam,
    @Body({ schema: portalReplySchema }) body: PortalReply,
    @Headers(PORTAL_TOKEN_HEADER) token: string | undefined,
    @Req() request: Request,
  ) {
    return parseResponse(
      portalReplyResultSchema,
      await this.tracking.reply(token, params.key, body, request.ip ?? null),
    );
  }

  @Post('track/resend')
  @Public()
  @HttpCode(202)
  @Audited({ action: AUDIT_ACTIONS.portalLinkResend, targetType: 'email' })
  @ApiOperation({
    summary: 'Email a new tracking link ("This link has expired")',
    description:
      'Always answers 202 with the same body and the same timing, whether or not the ticket exists ' +
      'and the address is its requester. When both match, a new link is queued by email. Limited ' +
      'per IP (429) and per address (silently).',
  })
  @ApiAcceptedResponse({ standardSchema: portalAcceptedSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async resend(@Body({ schema: portalResendSchema }) body: PortalResend, @Req() request: Request) {
    const ip = request.ip ?? null;
    await this.limits.enforce('resend-ip', ip ?? 'unknown');
    this.tracking.requestNewLink(body.ticketKey, body.email, ip);
    return parseResponse(portalAcceptedSchema, { status: 'accepted' });
  }
}
