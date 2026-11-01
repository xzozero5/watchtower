import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  lineLinkCodeRequestSchema,
  lineLinkCodeResultSchema,
  lineLoginCallbackQuerySchema,
  lineLoginStartSchema,
} from '@watchtower/shared';
import { z } from 'zod';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { ApiHttpError } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { LineIdentityService } from './line-identity.service.js';

type LinkCodeRequest = z.infer<typeof lineLinkCodeRequestSchema>;
type LoginCallbackQuery = z.infer<typeof lineLoginCallbackQuerySchema>;

/**
 * Who a LINE user is (PRD R-2.11): a code a staff member hands to a contact, and LINE Login for a
 * signed-in client. Until one of them links the LINE user id, the contact stays `unverified`.
 */
@ApiTags('line')
@Controller('v1/line')
export class LineIdentityController {
  constructor(@Inject(LineIdentityService) private readonly identity: LineIdentityService) {}

  @Post('link-codes')
  @HttpCode(201)
  @RequirePermission('ticket.handle')
  // The code is a credential for one link: never cached.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Generate a one-time LINE link code for a contact',
    description:
      'Staff hand the code to the customer, who sends it as a LINE message (`WT-XXXXX-XXXXX`). The ' +
      'LINE account is then linked to this contact and the contact is marked verified (R-2.11). ' +
      'Valid for 15 minutes, works once, a new code cancels the previous one. The code is returned ' +
      'only here; the server keeps a hash.',
  })
  @ApiCreatedResponse({ standardSchema: lineLinkCodeResultSchema })
  @ApiNotFoundResponse({ description: 'No such contact' })
  async createLinkCode(
    @Body({ schema: lineLinkCodeRequestSchema }) body: LinkCodeRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      lineLinkCodeResultSchema,
      await this.identity.issueLinkCode(body.contactId, { type: 'user', id: principal.userId }),
    );
  }

  @Post('login/start')
  @HttpCode(200)
  @RequirePermission('ticket.read.org')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Start LINE Login for the signed-in client',
    description:
      'Returns the URL of the LINE Login consent screen; the page sends the browser there. LINE ' +
      'sends it back to `/v1/line/login/callback`. In mock mode (no LINE Login channel configured, ' +
      'not production) the URL is the callback itself, approved as a synthetic LINE user. Without a ' +
      'live provider in production: 503.',
  })
  @ApiOkResponse({ standardSchema: lineLoginStartSchema })
  @ApiServiceUnavailableResponse({ description: 'LINE Login is not available on this instance' })
  async startLogin(@CurrentPrincipal() principal: Principal) {
    const authorizeUrl = await this.identity.startLogin(principal);
    if (authorizeUrl === null) {
      throw new ApiHttpError(
        503,
        'route_not_configured',
        'LINE Login is not available on this instance',
      );
    }
    return parseResponse(lineLoginStartSchema, { authorizeUrl });
  }

  @Get('login/callback')
  @RequirePermission('ticket.read.org')
  @Redirect()
  @ApiOperation({
    summary: 'LINE Login callback',
    description:
      'The browser lands here after LINE Login, with the session cookie. Links the LINE account to ' +
      'the signed-in client contact, then redirects to the portal with `line_login=linked` or ' +
      '`line_login=failed&reason=...`.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the portal' })
  async callback(
    @Query({ schema: lineLoginCallbackQuerySchema }) query: LoginCallbackQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    const outcome = await this.identity.finishLogin(principal, query);
    return { url: this.identity.portalRedirect(outcome), statusCode: 302 };
  }
}
