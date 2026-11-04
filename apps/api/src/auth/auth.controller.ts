import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  authConfigSchema,
  breakGlassLoginSchema,
  deviceListSchema,
  devLoginRequestSchema,
  magicLinkAcceptedSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  sessionIdParamSchema,
  sessionInfoSchema,
  type AuthMethod,
  type BreakGlassLogin,
  type DevLoginRequest,
  type MagicLinkRequest,
  type MagicLinkVerify,
  type SessionInfo,
} from '@watchtower/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AuthService, GoogleLoginRejected, requestMeta } from './auth.service.js';
import { BreakGlassService } from './break-glass.service.js';
import {
  clearOidcCookie,
  clearSessionCookies,
  cookieNames,
  hasDuplicateCookie,
  oidcCookieOptions,
  readCookie,
  setSessionCookies,
} from './cookies.js';
import { Audited, CurrentPrincipal, Public, RequirePermission } from './decorators.js';
import { GoogleOidcService, OidcError, sanitizeReturnTo } from './google-oidc.service.js';
import { RateLimitedError, invalidLink, invalidRefreshToken, notFound } from './http-errors.js';
import { MagicLinkService } from './magic-link.service.js';
import type { Principal } from './principal.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService, type IssuedSession } from './session.service.js';
import { TokenService } from './token.service.js';

const googleStartQuerySchema = z.object({
  /** Relative path to land on after sign-in. Anything else is replaced by `/`. */
  returnTo: z.string().max(200).optional(),
});

// Google appends code, state and a few informational parameters; only their presence matters here,
// the raw query string goes to the OIDC library.
const googleCallbackQuerySchema = z.looseObject({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

const FIFTEEN_MINUTES = 15 * 60;

function secondsUntil(date: Date): number {
  return Math.max(1, Math.floor((date.getTime() - Date.now()) / 1000));
}

/**
 * Sign-in, session renewal and sign-out. Browser contract (also for T-006):
 *
 *  - Sign-in sets two HttpOnly cookies (`wt_at` access JWT, `wt_rt` refresh token; named
 *    `__Host-wt_at` / `__Host-wt_rt` when cookies are Secure, which the browser handles by itself) and returns
 *    SessionInfo in the body, including `csrfToken`. Tokens are never in a JSON body.
 *  - Send `credentials: 'include'` on every fetch. Send `x-csrf-token: <csrfToken>` on every POST,
 *    PUT, PATCH and DELETE to a signed-in route.
 *  - On a 401 call POST /v1/auth/refresh once (from one tab at a time), then retry. Its 401 means
 *    the session is over: show the login page.
 *  - Reload: call GET /v1/auth/session to get the csrfToken back.
 */
@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(GoogleOidcService) private readonly oidc: GoogleOidcService,
    @Inject(MagicLinkService) private readonly magicLinks: MagicLinkService,
    @Inject(BreakGlassService) private readonly breakGlass: BreakGlassService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private async signIn(
    request: Request,
    response: Response,
    user: Parameters<AuthService['sessionInfo']>[0],
    method: AuthMethod,
    extraMetadata: Readonly<Record<string, string>> = {},
  ): Promise<SessionInfo> {
    const issued = await this.sessions.issue(user, method, requestMeta(request));
    this.setCookies(response, issued);
    AuditScope.set({
      actor: { type: 'user', id: user.id },
      targetType: 'session',
      targetId: issued.sessionId,
      metadata: { authMethod: method, ...extraMetadata },
    });
    return this.auth.sessionInfo(user, issued, method);
  }

  private setCookies(response: Response, issued: IssuedSession): void {
    setSessionCookies(response, this.config, {
      accessToken: issued.accessToken,
      accessMaxAgeSeconds: secondsUntil(issued.accessExpiresAt),
      refreshToken: issued.refreshToken,
      refreshMaxAgeSeconds: secondsUntil(issued.refreshExpiresAt),
    });
  }

  private stepUpRedirect(
    returnTo: string,
    result: 'ok' | 'failed',
  ): { url: string; statusCode: number } {
    const url = new URL(returnTo, this.config.APP_URL);
    url.searchParams.set('stepup', result);
    return { url: url.toString(), statusCode: 302 };
  }

  private loginRedirect(error: string): { url: string; statusCode: number } {
    const url = new URL('/login', this.config.APP_URL);
    url.searchParams.set('error', error);
    return { url: url.toString(), statusCode: 302 };
  }

  @Get('config')
  @Public()
  @ApiOperation({
    summary: 'Which sign-in methods this instance offers',
    description:
      'Public. The login page reads it: `google.mode` is `mock` (no Google credentials, dev login ' +
      'available) or `live`.',
  })
  @ApiOkResponse({ standardSchema: authConfigSchema })
  authConfig() {
    return parseResponse(authConfigSchema, {
      google: {
        mode: this.config.googleMode,
        startPath: this.oidc.live ? '/v1/auth/google/start' : null,
      },
      devLoginEnabled: this.config.devLoginEnabled,
      magicLinkEnabled: true,
      breakGlassEnabled: true,
    });
  }

  @Get('google/start')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Start Google sign-in for staff (live mode only)',
    description:
      'Navigate the browser here. Redirects to Google (authorization code + PKCE). 404 in mock mode.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to Google, or to the login page on error' })
  @ApiNotFoundResponse({ description: 'Google sign-in is not configured (mock mode)' })
  async googleStart(
    @Query({ schema: googleStartQuerySchema }) query: z.infer<typeof googleStartQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.oidc.live) throw notFound('Google sign-in is not configured');
    try {
      const { url, cookie } = await this.oidc.start(query.returnTo);
      response.cookie(cookieNames(this.config).oidc, cookie, oidcCookieOptions(this.config));
      return { url, statusCode: 302 };
    } catch (error) {
      if (error instanceof OidcError) return this.loginRedirect(error.failure);
      throw error;
    }
  }

  @Get('google/step-up')
  @RequirePermission('auth.session.self')
  @Redirect()
  @ApiOperation({
    summary: 'Prove who you are again at Google (step-up of the signed-in session)',
    description:
      'Navigate the browser here from a signed-in session (T-306a C-5). Redirects to Google with `prompt=login` and ' +
      '`max_age=300`; the callback checks the `auth_time` of the ID token and, if it is within 5 minutes, records the ' +
      'step-up on THIS session (no new session is made), then returns to `returnTo` with `stepup=ok` (or `stepup=failed`). ' +
      'Approving a stage 3 promotion needs such a step-up. 404 in mock mode.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to Google' })
  @ApiNotFoundResponse({ description: 'Google sign-in is not configured (mock mode)' })
  async googleStepUp(
    @Query({ schema: googleStartQuerySchema }) query: z.infer<typeof googleStartQuerySchema>,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.oidc.live) throw notFound('Google sign-in is not configured');
    try {
      const { url, cookie } = await this.oidc.start(query.returnTo, {
        sessionId: principal.sessionId,
        userId: principal.userId,
        email: principal.email,
      });
      response.cookie(cookieNames(this.config).oidc, cookie, oidcCookieOptions(this.config));
      return { url, statusCode: 302 };
    } catch (error) {
      if (error instanceof OidcError) {
        return this.stepUpRedirect(sanitizeReturnTo(query.returnTo), 'failed');
      }
      throw error;
    }
  }

  @Get('google/callback')
  @Public()
  @Redirect()
  @Audited({ action: AUDIT_ACTIONS.loginGoogle, targetType: 'session', always: true })
  @ApiOperation({
    summary: 'Google redirects here after sign-in',
    description:
      'Verifies state, nonce and the ID token, then requires a verified email and the ' +
      '`GOOGLE_ALLOWED_DOMAIN` Workspace domain (`hd` claim) or an address on `GOOGLE_ALLOWED_EMAILS` ' +
      '(trial instances only) on a provisioned staff account. Sets ' +
      'the session cookies and redirects to the web app; on any failure redirects to `/login?error=<code>`.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the web app' })
  async googleCallback(
    @Query({ schema: googleCallbackQuerySchema }) _query: z.infer<typeof googleCallbackQuerySchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const fail = (reason: string) => {
      AuditScope.set({
        action: AUDIT_ACTIONS.loginGoogleFailed,
        outcome: 'failure',
        metadata: { reason },
      });
      clearOidcCookie(response, this.config);
      return this.loginRedirect(reason);
    };

    if (!this.oidc.live) return fail('google_unavailable');
    const query = new URL(request.originalUrl, 'http://placeholder.invalid').searchParams;
    try {
      const identity = await this.oidc.finish(
        query,
        readCookie(request, cookieNames(this.config).oidc),
      );
      const { user, via } = await this.auth.resolveGoogleUser(identity);
      if (identity.stepUp !== undefined) {
        // A step-up, not a sign-in: the session that asked for it keeps its identity and gets the proof (C-5).
        const stepped =
          user.id === identity.stepUp.userId && identity.authTime !== undefined
            ? await this.sessions.recordStepUp(
                identity.stepUp.sessionId,
                user.id,
                new Date(identity.authTime * 1000),
                'google_oidc',
              )
            : false;
        clearOidcCookie(response, this.config);
        AuditScope.set({
          actor: { type: 'user', id: user.id },
          action: stepped ? AUDIT_ACTIONS.stepUpGoogle : AUDIT_ACTIONS.stepUpFailed,
          outcome: stepped ? 'success' : 'failure',
          targetType: 'session',
          targetId: identity.stepUp.sessionId,
          metadata: {
            authMethod: 'google_oidc',
            ...(stepped ? {} : { reason: 'session_or_account_mismatch' }),
          },
        });
        return this.stepUpRedirect(identity.returnTo, stepped ? 'ok' : 'failed');
      }
      await this.signIn(request, response, user, 'google', { via });
      clearOidcCookie(response, this.config);
      return { url: new URL(identity.returnTo, this.config.APP_URL).toString(), statusCode: 302 };
    } catch (error) {
      if (error instanceof OidcError) {
        if (error.failure === 'reauth_stale') {
          AuditScope.set({
            action: AUDIT_ACTIONS.stepUpFailed,
            outcome: 'failure',
            metadata: { reason: 'auth_time_stale' },
          });
          clearOidcCookie(response, this.config);
          return this.loginRedirect('reauth_stale');
        }
        return fail(error.failure);
      }
      if (error instanceof GoogleLoginRejected) return fail(error.failure);
      throw error;
    }
  }

  @Post('dev-login')
  @Public()
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.loginDev, targetType: 'session' })
  @ApiOperation({
    summary: 'Development sign-in without a password (mock mode only)',
    description:
      'Exists only when DEV_LOGIN_ENABLED=true, Google credentials are empty and NODE_ENV is not ' +
      'production; otherwise 404. Creates the account on first use and signs in only to accounts ' +
      'it created (any other account is 403).',
  })
  @ApiOkResponse({ standardSchema: sessionInfoSchema })
  @ApiNotFoundResponse({ description: 'Not available (live mode or production)' })
  async devLogin(
    @Body({ schema: devLoginRequestSchema }) body: DevLoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.auth.devLogin(body);
    return parseResponse(sessionInfoSchema, await this.signIn(request, response, user, 'dev'));
  }

  @Post('magic-link/request')
  @Public()
  @HttpCode(202)
  @Audited({ action: AUDIT_ACTIONS.magicLinkRequested, targetType: 'email' })
  @ApiOperation({
    summary: 'Email a one-time sign-in link to a client',
    description:
      'Always answers 202 with the same body, whether or not the address has an account, so it ' +
      'cannot be used to find out who is a customer. Limited per IP address (429) and per address ' +
      '(silently). The email is sent through the queue by the worker (Mailpit locally).',
  })
  @ApiAcceptedResponse({ standardSchema: magicLinkAcceptedSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP address' })
  async requestMagicLink(
    @Body({ schema: magicLinkRequestSchema }) body: MagicLinkRequest,
    @Req() request: Request,
  ) {
    const ip = request.ip ?? null;
    try {
      await this.limiter.enforce('magic-ip', ip ?? 'unknown', 10, FIFTEEN_MINUTES);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        AuditScope.set({ action: AUDIT_ACTIONS.magicLinkRateLimited, outcome: 'denied' });
      }
      throw error;
    }
    this.magicLinks.request(body.email, ip);
    return parseResponse(magicLinkAcceptedSchema, { status: 'accepted' });
  }

  @Post('magic-link/verify')
  @Public()
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.magicLinkLogin, targetType: 'session' })
  @ApiOperation({
    summary: 'Exchange a magic-link token for a session',
    description:
      'The web page opened by the emailed link reads `token` from the URL fragment and POSTs it ' +
      'here. A token works once and expires after MAGIC_LINK_TTL_SECONDS; any other case is 401 ' +
      '`invalid_or_expired_link`.',
  })
  @ApiOkResponse({ standardSchema: sessionInfoSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts from this IP address' })
  async verifyMagicLink(
    @Body({ schema: magicLinkVerifySchema }) body: MagicLinkVerify,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limiter.enforce('magic-verify-ip', request.ip ?? 'unknown', 20, FIFTEEN_MINUTES);
    const user = await this.magicLinks.consume(body.token);
    if (!user) {
      AuditScope.set({ action: AUDIT_ACTIONS.magicLinkFailed, outcome: 'failure' });
      throw invalidLink();
    }
    return parseResponse(
      sessionInfoSchema,
      await this.signIn(request, response, user, 'magic_link'),
    );
  }

  @Post('break-glass')
  @Public()
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.breakGlassLogin, targetType: 'session' })
  @ApiOperation({
    summary: 'Break-glass local admin sign-in (role head)',
    description:
      'For when Google sign-in is down. 401 `invalid_credentials` for a wrong password, an unknown ' +
      'account and a locked account alike. The 5th wrong password from one IP address locks that ' +
      'address out of that account for 60 seconds, doubling with each further wrong password up to ' +
      'an hour; other addresses are not affected. 10 attempts per IP per 15 minutes (429). Every ' +
      'attempt is audited.',
  })
  @ApiOkResponse({ standardSchema: sessionInfoSchema })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts from this IP address' })
  async breakGlassLogin(
    @Body({ schema: breakGlassLoginSchema }) body: BreakGlassLogin,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.breakGlass.authenticate(body.email, body.password, request.ip ?? null);
    return parseResponse(
      sessionInfoSchema,
      await this.signIn(request, response, user, 'break_glass'),
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.refresh, targetType: 'session' })
  @ApiOperation({
    summary: 'Renew the session',
    description:
      'Uses the refresh cookie (`wt_rt`; `__Host-wt_rt` when Secure). Each refresh token works once and is replaced by a new one. ' +
      'Presenting an already-used token revokes the whole session (401 and cleared cookies). ' +
      'Call it from one tab at a time.',
  })
  @ApiOkResponse({ standardSchema: sessionInfoSchema })
  @ApiResponse({
    status: 401,
    description: 'The session is over; sign in again (invalid_refresh_token)',
  })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.limiter.enforce('refresh-ip', request.ip ?? 'unknown', 120, 60);
    const names = cookieNames(this.config);
    const token = readCookie(request, names.refresh);
    if (!token) {
      // A repeated cookie reads as absent: we cannot know which copy is ours (see readCookie).
      AuditScope.set({
        outcome: 'failure',
        metadata: {
          reason: hasDuplicateCookie(request, names.refresh)
            ? 'duplicate_refresh_cookie'
            : 'no_refresh_cookie',
        },
      });
      throw invalidRefreshToken();
    }
    const result = await this.sessions.refresh(token, requestMeta(request));
    if (!result.ok) {
      clearSessionCookies(response, this.config);
      AuditScope.set({
        action: result.reason === 'reuse' ? AUDIT_ACTIONS.refreshReuse : AUDIT_ACTIONS.refresh,
        outcome: 'failure',
        ...(result.userId ? { actor: { type: 'user' as const, id: result.userId } } : {}),
        ...(result.sessionId ? { targetId: result.sessionId } : {}),
        metadata: { reason: result.reason },
      });
      throw invalidRefreshToken();
    }
    this.setCookies(response, result.session);
    AuditScope.set({
      actor: { type: 'user', id: result.user.id },
      targetId: result.session.sessionId,
    });
    return parseResponse(
      sessionInfoSchema,
      await this.auth.sessionInfo(result.user, result.session, result.authMethod),
    );
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @Audited({ action: AUDIT_ACTIONS.logout, targetType: 'session' })
  @ApiOperation({
    summary: 'End the current session',
    description: 'Idempotent. Revokes the session behind the cookies and clears them.',
  })
  @ApiNoContentResponse()
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const names = cookieNames(this.config);
    const access = readCookie(request, names.access);
    const refresh = readCookie(request, names.refresh);
    const claims = access ? await this.tokens.verifyAccessToken(access) : null;
    const sessionId =
      claims?.sessionId ?? (refresh ? await this.sessions.sessionIdForRefreshToken(refresh) : null);
    if (sessionId) {
      const owner = await this.sessions.sessionOwner(sessionId);
      if (owner) {
        await this.sessions.revoke(sessionId, 'logout');
        AuditScope.set({ actor: { type: 'user', id: owner }, targetId: sessionId });
      }
    }
    clearSessionCookies(response, this.config);
  }

  @Get('session')
  @RequirePermission('auth.session.self')
  @ApiOperation({
    summary: 'Who am I',
    description: 'Current user, effective permissions and the CSRF token for this session.',
  })
  @ApiOkResponse({ standardSchema: sessionInfoSchema })
  session(@CurrentPrincipal() principal: Principal) {
    return parseResponse(sessionInfoSchema, {
      user: {
        id: principal.userId,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        orgId: principal.orgId,
      },
      permissions: [...principal.permissions].toSorted(),
      sessionId: principal.sessionId,
      authMethod: principal.authMethod,
      csrfToken: this.tokens.csrfTokenFor(principal.sessionId),
      accessExpiresAt: principal.accessExpiresAt.toISOString(),
    });
  }

  @Get('sessions')
  @RequirePermission('auth.session.self')
  @ApiOperation({ summary: 'List my signed-in devices' })
  @ApiOkResponse({ standardSchema: deviceListSchema })
  async devices(@CurrentPrincipal() principal: Principal) {
    return parseResponse(deviceListSchema, {
      devices: await this.sessions.listDevices(principal.userId, principal.sessionId),
    });
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @RequirePermission('auth.session.self')
  @Audited({ action: AUDIT_ACTIONS.sessionRevoke, targetType: 'session' })
  @ApiOperation({ summary: 'Sign out one of my devices' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not one of my live sessions' })
  async revokeDevice(
    @Param({ schema: sessionIdParamSchema }) params: z.infer<typeof sessionIdParamSchema>,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revoked = await this.sessions.revoke(params.id, 'user_revoked', principal.userId);
    if (!revoked) throw notFound('No such session');
    if (params.id === principal.sessionId) clearSessionCookies(response, this.config);
  }
}
