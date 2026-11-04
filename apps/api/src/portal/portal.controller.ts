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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConsumes,
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
  PORTAL_ATTACHMENT_EXTENSIONS,
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_FILES,
  PORTAL_ATTACHMENT_MAX_TOTAL_BYTES,
  PORTAL_MULTIPART_FILES_FIELD,
  PORTAL_MULTIPART_PAYLOAD_FIELD,
  PORTAL_TOKEN_HEADER,
  humanChallengeSchema,
  portalAcceptedSchema,
  portalMyRequestsRequestSchema,
  portalMyRequestsViewSchema,
  portalReplyRequestSchema,
  portalReplyResultSchema,
  portalReplySchema,
  portalResendSchema,
  portalSubmitRequestSchema,
  portalSubmitSchema,
  portalSubmittedSchema,
  portalTicketKeyParamSchema,
  portalTicketViewSchema,
  type PortalMyRequestsRequest,
  type PortalReplyRequest,
  type PortalResend,
  type PortalSubmitRequest,
} from '@watchtower/shared';
import type { Request } from 'express';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { EmailTagService } from '../audit/email-tag.service.js';
import { Audited, Public } from '../auth/decorators.js';
import { invalidTrackingLink, verificationFailed } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { HUMAN_VERIFICATION, type HumanVerificationProvider } from './human-verification.js';
import type { UploadedFile } from './portal-attachments.service.js';
import { PortalHeadersInterceptor } from './portal-headers.interceptor.js';
import { PortalLimits } from './portal-limits.js';
import { PortalMyRequestsService } from './portal-my-requests.service.js';
import { resolvePortalBody } from './portal-request.js';
import { PortalUploadInterceptor } from './portal-upload.interceptor.js';
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
    @Inject(PortalMyRequestsService) private readonly myRequests: PortalMyRequestsService,
    @Inject(EmailTagService) private readonly tags: EmailTagService,
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
      'The tracking link is only in that email. Attachments (R-9.1): send `multipart/form-data` ' +
      `with the form as JSON in the \`${PORTAL_MULTIPART_PAYLOAD_FIELD}\` field and up to ` +
      `${String(PORTAL_ATTACHMENT_MAX_FILES)} files in \`${PORTAL_MULTIPART_FILES_FIELD}\` ` +
      `(${String(PORTAL_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB each, ` +
      `${String(PORTAL_ATTACHMENT_MAX_TOTAL_BYTES / 1024 / 1024)} MB together; ` +
      `${PORTAL_ATTACHMENT_EXTENSIONS.join(', ')}). The type is decided from the file's bytes, ` +
      'not its name; SVG, HTML and anything else is 400 `attachment_rejected` (413 for size or ' +
      'count). Without files, plain JSON as before. Limited per IP, per email and per ' +
      'organization (429 with Retry-After); a failed verification is 400 `verification_failed`.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiCreatedResponse({ standardSchema: portalSubmittedSchema })
  @ApiBadRequestResponse({
    description: 'Invalid form, verification_failed, or attachment_rejected',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit (portal.rate_limited is audited)' })
  @UseInterceptors(PortalUploadInterceptor)
  async submit(
    @Body({ schema: portalSubmitRequestSchema }) body: PortalSubmitRequest,
    @UploadedFiles() files: UploadedFile[] | undefined,
    @Req() request: Request,
  ) {
    return parseResponse(
      portalSubmittedSchema,
      await this.submissions.submit(
        resolvePortalBody(portalSubmitSchema, body),
        { ip: request.ip ?? null },
        files ?? [],
      ),
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
      'per IP and per ticket. Files (R-9.3) go the same way as on submit: `multipart/form-data` ' +
      `with the JSON in \`${PORTAL_MULTIPART_PAYLOAD_FIELD}\` and the files in ` +
      `\`${PORTAL_MULTIPART_FILES_FIELD}\`, same limits and checks.`,
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiCreatedResponse({ standardSchema: portalReplyResultSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiBadRequestResponse({ description: 'Invalid reply, or attachment_rejected' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit' })
  @UseInterceptors(PortalUploadInterceptor)
  async reply(
    @Param({ schema: portalTicketKeyParamSchema }) params: KeyParam,
    @Body({ schema: portalReplyRequestSchema }) body: PortalReplyRequest,
    @UploadedFiles() files: UploadedFile[] | undefined,
    @Headers(PORTAL_TOKEN_HEADER) token: string | undefined,
    @Req() request: Request,
  ) {
    return parseResponse(
      portalReplyResultSchema,
      await this.tracking.reply(
        token,
        params.key,
        resolvePortalBody(portalReplySchema, body),
        request.ip ?? null,
        files ?? [],
      ),
    );
  }

  @Post('my-requests')
  @Public()
  @HttpCode(202)
  @Audited({ action: AUDIT_ACTIONS.portalMyRequestsRequest, targetType: 'email' })
  @ApiOperation({
    summary: 'Email me a link to my requests',
    description:
      'For a customer who lost their tracking links (T-152). Needs the proof of work of the submit ' +
      'form and an empty honeypot. Answers 202 with the same body and the same timing whatever the ' +
      'address is: a contact, a stranger, or limited per address, per domain or by the instance ' +
      'ceiling. When the address belongs to a contact, an email with a one-time link (30 minutes) ' +
      'is queued after the response. No account is ever created. A bad proof is 400 ' +
      '`verification_failed`; per IP (the /64 of an IPv6 address) 429.',
  })
  @ApiAcceptedResponse({ standardSchema: portalAcceptedSchema })
  @ApiBadRequestResponse({ description: 'verification_failed or an invalid body' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async requestMyRequests(
    @Body({ schema: portalMyRequestsRequestSchema }) body: PortalMyRequestsRequest,
    @Req() request: Request,
  ) {
    const ip = request.ip ?? null;
    await this.limits.enforce('mine-ip', ip ?? 'unknown');
    const emailTag = this.tags.tag(body.email);
    AuditScope.set({ targetType: 'email', targetId: emailTag });
    // Stateless checks first, then the single-use claim; nothing below depends on the address.
    const checked = await this.verification.check({
      proof: body.verification,
      honeypot: body.website,
    });
    if (!checked.ok) {
      AuditScope.set({
        action: AUDIT_ACTIONS.portalVerificationFailed,
        outcome: 'denied',
        metadata: { reason: checked.reason, provider: this.verification.name, flow: 'my_requests' },
      });
      // A bot that filled the trap gets the answer a person gets, and no email.
      if (checked.reason === 'honeypot') {
        return parseResponse(portalAcceptedSchema, { status: 'accepted' });
      }
      throw verificationFailed();
    }
    const claimed = await this.verification.claim(checked);
    if (!claimed.ok) {
      AuditScope.set({
        action: AUDIT_ACTIONS.portalVerificationFailed,
        outcome: 'denied',
        metadata: { reason: claimed.reason, provider: this.verification.name, flow: 'my_requests' },
      });
      throw verificationFailed();
    }
    this.myRequests.request(body.email, body.locale, ip);
    return parseResponse(portalAcceptedSchema, { status: 'accepted' });
  }

  @Post('my-requests/open')
  @Public()
  @HttpCode(200)
  @tokenHeader
  @Audited({ action: AUDIT_ACTIONS.portalMyRequestsOpened, targetType: 'contact' })
  @ApiOperation({
    summary: 'Open the one-time "my requests" link',
    description:
      'The page sends the token from the emailed link (`#token=...`) in `X-Portal-Token`. It works ' +
      'once: the first call spends it and returns the read-only list of the requests of the contact ' +
      'that owns the address (status in the customer words, no internal notes, no AI, no ' +
      'organization-wide view), each open request with its own tracking token. Unknown, used, ' +
      'expired and replaced links all answer the same 401.',
  })
  @ApiOkResponse({ standardSchema: portalMyRequestsViewSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async openMyRequests(
    @Headers(PORTAL_TOKEN_HEADER) token: string | undefined,
    @Req() request: Request,
  ) {
    await this.limits.enforce('mine-open-ip', request.ip ?? 'unknown');
    const opened = await this.myRequests.open(token);
    if (opened === null) {
      AuditScope.set({ action: AUDIT_ACTIONS.portalAccessDenied, outcome: 'denied' });
      throw invalidTrackingLink();
    }
    AuditScope.set({
      targetId: opened.contactId,
      metadata: {
        emailTag: opened.emailTag,
        ticketCount: opened.view.items.length,
        truncated: opened.view.truncated,
      },
    });
    return parseResponse(portalMyRequestsViewSchema, opened.view);
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
