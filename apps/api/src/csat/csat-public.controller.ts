import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  CSAT_TOKEN_HEADER,
  csatResponseInputSchema,
  csatResponseResultSchema,
  csatSurveyViewSchema,
  type CsatResponseInput,
} from '@watchtower/shared';
import type { Request } from 'express';

import { Audited, Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { PortalHeadersInterceptor } from '../portal/portal-headers.interceptor.js';
import { CsatPublicService } from './csat-public.service.js';

const tokenHeader = ApiHeader({
  name: CSAT_TOKEN_HEADER,
  required: true,
  description:
    'The survey token from the emailed link (`#token=...` in the URL fragment). Sent by the page ' +
    'in this header; never in a URL, a query string or a cookie.',
});

/**
 * The public survey page of a resolved ticket (PRD R-10.2, T-110b). No session and no cookie: the
 * signed single-use token in `X-Csat-Token` is the only credential, so there is no ambient authority
 * for CSRF to borrow. Responses are `no-store` and `no-referrer` (the same headers as the portal).
 *
 * Browser contract (for the page):
 *  1. The email links to `/csat#token=<token>&score=<1-5>`. The page reads the fragment, removes it
 *     from the address bar (`history.replaceState`) and keeps the token in memory.
 *  2. `GET /survey` with the token: 200 shows the request key; 401 `invalid_or_expired_link` shows
 *     "this link has expired"; 409 shows "thank you, already answered".
 *  3. `POST /responses` with the score (preselected from the link), the optional comment and
 *     "was this resolved?". The link works once.
 */
@ApiTags('csat')
@Controller('v1/csat')
@UseInterceptors(PortalHeadersInterceptor)
export class CsatPublicController {
  constructor(@Inject(CsatPublicService) private readonly service: CsatPublicService) {}

  @Get('survey')
  @Public()
  @tokenHeader
  @ApiOperation({
    summary: 'The request a survey link is about',
    description:
      'Public. A missing, malformed, forged, expired, voided or never-sent token all answer the ' +
      'same 401. A valid token whose survey was already answered answers 409. Limited per IP.',
  })
  @ApiOkResponse({ standardSchema: csatSurveyViewSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiConflictResponse({ description: 'The survey was already answered' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async view(@Headers(CSAT_TOKEN_HEADER) token: string | undefined, @Req() request: Request) {
    return parseResponse(csatSurveyViewSchema, await this.service.view(token, request.ip ?? null));
  }

  @Post('responses')
  @Public()
  @HttpCode(201)
  @tokenHeader
  @Audited({ action: AUDIT_ACTIONS.csatResponse, targetType: 'csat_survey' })
  @ApiOperation({
    summary: 'Answer the survey (once)',
    description:
      'Records the 1-5 score, the optional comment and "was this resolved?". The first answer wins; ' +
      'the link then answers 409. A score below 3, or "not resolved", reopens a ticket that was ' +
      'resolved in the last 7 days (R-1.10); the reply does not say whether it did. Limited per IP ' +
      'and per survey.',
  })
  @ApiOkResponse({ standardSchema: csatResponseResultSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_or_expired_link' })
  @ApiConflictResponse({ description: 'The survey was already answered' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit (csat.rate_limited is audited)' })
  async answer(
    @Body({ schema: csatResponseInputSchema }) body: CsatResponseInput,
    @Headers(CSAT_TOKEN_HEADER) token: string | undefined,
    @Req() request: Request,
  ) {
    return parseResponse(
      csatResponseResultSchema,
      await this.service.answer(token, body, request.ip ?? null),
    );
  }
}
