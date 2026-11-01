import { Body, Controller, Get, HttpCode, Inject, Post, Query, Redirect } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  gmailConnectionStatusSchema,
  gmailOauthDisconnectResultSchema,
  gmailOauthStartResultSchema,
  gmailOauthStartSchema,
  type GmailOauthStart,
} from '@watchtower/shared';
import { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { GmailOauthService } from './gmail-oauth.service.js';

// Google appends `code`, `state`, `scope` and sometimes `authuser`, `hd`, `prompt`; only these three are
// used and each is bounded. Extra parameters are ignored (and never logged: the access log keeps the path only).
const callbackQuerySchema = z.looseObject({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Connect the support mailbox by OAuth (T-102e), `head` only (`integration.manage`). Both routes need
 * the signed-in session: `start` is a POST (CSRF-protected like every write), the callback is the
 * GET Google redirects the browser to, which carries the session cookie (SameSite=Lax allows a
 * top-level navigation). The UI is T-116c.
 */
@ApiTags('admin')
@Controller('v1/admin/integrations/gmail/oauth')
@RequirePermission('integration.manage')
export class GmailOauthController {
  constructor(@Inject(GmailOauthService) private readonly oauth: GmailOauthService) {}

  @Get('status')
  @ApiOperation({
    summary: 'How the Gmail mailbox is connected (head)',
    description:
      'Whether the OAuth client is set, whether a mailbox is connected, which way the worker uses ' +
      '(environment beats database, then OAuth beats a service account), whether Google refused the ' +
      'token and the mailbox must be connected again, and the redirect URI to register. Never a secret.',
  })
  @ApiOkResponse({ standardSchema: gmailConnectionStatusSchema })
  async status() {
    return parseResponse(gmailConnectionStatusSchema, await this.oauth.status());
  }

  @Post('start')
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.gmailOauthStart, targetType: 'integration' })
  @ApiOperation({
    summary: 'Start connecting the support mailbox (head)',
    description:
      'Returns the Google consent URL (authorization code + PKCE, `access_type=offline`, ' +
      '`prompt=consent`, scopes `gmail.readonly` and `gmail.send`). Send the browser there. The state ' +
      'is bound to this session and works once within ten minutes. 409 when the OAuth client is not ' +
      'saved yet (`conflict`) or the refresh token/mailbox are set by the environment ' +
      '(`credential_env_locked`).',
  })
  @ApiOkResponse({ standardSchema: gmailOauthStartResultSchema })
  @ApiBadRequestResponse({ description: 'The mailbox is not an email address' })
  @ApiConflictResponse({ description: 'OAuth client not saved, or environment-locked' })
  @ApiTooManyRequestsResponse({ description: 'More than 10 starts in a minute' })
  async start(
    @Body({ schema: gmailOauthStartSchema }) body: GmailOauthStart,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(gmailOauthStartResultSchema, await this.oauth.start(principal, body));
  }

  @Post('disconnect')
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.gmailOauthDisconnect, targetType: 'integration' })
  @ApiOperation({
    summary: 'Disconnect the OAuth mailbox (head)',
    description:
      'Revokes the refresh token at Google (best effort; the result is in the answer and the audit ' +
      'entry), then deletes it and the mailbox from the credential store. The generic credential ' +
      'routes refuse those two fields. 409 when the environment sets them.',
  })
  @ApiOkResponse({ standardSchema: gmailOauthDisconnectResultSchema })
  @ApiConflictResponse({ description: 'The grant is set by an environment variable' })
  async disconnect(@CurrentPrincipal() principal: Principal) {
    return parseResponse(gmailOauthDisconnectResultSchema, await this.oauth.disconnect(principal));
  }

  @Get('callback')
  @Redirect()
  @Audited({ action: AUDIT_ACTIONS.gmailOauthConnect, targetType: 'integration', always: true })
  @ApiOperation({
    summary: 'Google redirects here after consent (head)',
    description:
      'Checks the state (bound to this session, single use), the granted scopes (exactly ' +
      '`gmail.readonly` + `gmail.send`) and that the granting account is the mailbox asked for, then ' +
      'stores the refresh token encrypted. Always redirects to `<APP_URL>/admin/integrations` with ' +
      '`?gmail_oauth=<result>`; nothing sensitive is in the redirect.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the admin page with a result code' })
  @ApiTooManyRequestsResponse({ description: 'More than 20 callbacks in a minute' })
  async callback(
    @Query({ schema: callbackQuerySchema }) query: z.infer<typeof callbackQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.oauth.finish(principal, {
      code: query.code,
      state: query.state,
      error: query.error,
    });
    return { url: this.oauth.resultUrl(result), statusCode: 302 };
  }
}
