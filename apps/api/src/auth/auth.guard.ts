import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUDIT_ACTIONS,
  CSRF_HEADER,
  WORKSPACE_ROLES,
  type Permission,
  type Role,
} from '@watchtower/shared';
import type { Request, Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { AuthService } from './auth.service.js';
import { cookieNames, hasDuplicateCookie, readCookie } from './cookies.js';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  WORKSPACE_ONLY_KEY,
} from './decorators.js';
import { ApiHttpError, forbidden, unauthenticated } from './http-errors.js';
import { satisfiesRequirement } from './permission-check.js';
import { attachPrincipal, type Principal } from './principal.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The global gate (APP_GUARD): deny by default.
 *
 *  1. `@Public()` routes pass.
 *  2. A route with no permission decorator is a configuration error and answers 403, even to a
 *     head. A forgotten decorator therefore fails closed instead of exposing the route.
 *  3. Otherwise the access cookie must hold a valid JWT, the session must be live and the user
 *     active (read from the database on every request, so forced logout and disabling apply at
 *     once), and the user's role must grant the permission.
 *     A route marked `@WorkspaceOnly()` first refuses every role outside agent/lead/head/dev (403), granted or not.
 *  4. Unsafe methods must also carry the session's CSRF token in `x-csrf-token`.
 *
 * Denials of a signed-in user (403, CSRF) are written to the audit log here, because a rejected
 * request never reaches the audit interceptor.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'cookieSecure'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true) {
      return true;
    }
    // Only HTTP is authenticated here. A WebSocket gateway or any other transport that reaches this
    // guard is refused unless it is marked @Public() and authenticates the connection itself
    // (T-005: validate the access cookie with TokenService and SessionService in the handshake).
    if (context.getType() !== 'http') return false;

    const request = context.switchToHttp().getRequest<Request>();
    const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    const anyOf = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      ANY_PERMISSIONS_KEY,
      targets,
    );
    if (!required && !anyOf) {
      this.logger.error(
        { method: request.method, route: this.routeOf(request) },
        'route has neither @Public() nor a permission decorator; denying',
      );
      throw new ApiHttpError(403, 'route_not_configured', 'This route has no access rule');
    }

    const principal = await this.authenticate(request);
    attachPrincipal(request, principal);

    // Before any permission: a role outside the workspace is refused whatever it was granted.
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(WORKSPACE_ONLY_KEY, targets) === true &&
      // An allowlist (T-400 C-9): a role that is not listed, or a principal scoped to one organization, is out.
      !((WORKSPACE_ROLES as readonly Role[]).includes(principal.role) && principal.orgScope.kind === 'all')
    ) {
      await this.deny(request, context, principal, AUDIT_ACTIONS.authzDenied, {
        required: required ?? [],
        anyOf: anyOf ?? [],
        workspaceOnly: true,
      });
      throw forbidden();
    }

    if (!satisfiesRequirement(principal.permissions, { all: required, anyOf })) {
      await this.deny(request, context, principal, AUDIT_ACTIONS.authzDenied, {
        required: required ?? [],
        anyOf: anyOf ?? [],
      });
      throw forbidden();
    }

    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.header(CSRF_HEADER);
      if (!this.tokens.isValidCsrfToken(principal.sessionId, presented)) {
        await this.deny(request, context, principal, AUDIT_ACTIONS.csrfRejected, {
          headerPresent: presented !== undefined,
        });
        throw new ApiHttpError(403, 'csrf_invalid', 'Missing or invalid CSRF token');
      }
    }
    return true;
  }

  private async authenticate(request: Request): Promise<Principal> {
    const name = cookieNames(this.config).access;
    const token = readCookie(request, name);
    if (!token) {
      // Two cookies of the auth name are never ours (a sibling subdomain or a proxy planted one):
      // refuse rather than guess which copy to believe.
      if (hasDuplicateCookie(request, name)) {
        this.logger.warn(
          { route: this.routeOf(request) },
          'request carries the access cookie more than once; treating it as unauthenticated',
        );
      }
      throw unauthenticated();
    }
    const claims = await this.tokens.verifyAccessToken(token);
    if (!claims) throw unauthenticated();
    const live = await this.sessions.authenticate(claims);
    if (!live) throw unauthenticated();
    return this.auth.principalFor(live.user, live.session, claims.expiresAt);
  }

  private routeOf(request: Request): string {
    const route: unknown = request.route;
    if (
      typeof route === 'object' &&
      route !== null &&
      'path' in route &&
      typeof route.path === 'string'
    ) {
      return route.path;
    }
    return request.path;
  }

  private async deny(
    request: Request,
    context: ExecutionContext,
    principal: Principal,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const rawRequestId = context.switchToHttp().getResponse<Response>().getHeader('x-request-id');
    try {
      await this.audit.record({
        actor: { type: 'user', id: principal.userId },
        action,
        outcome: 'denied',
        ip: request.ip ?? null,
        requestId: typeof rawRequestId === 'string' ? rawRequestId : null,
        metadata: { method: request.method, route: this.routeOf(request), ...metadata },
      });
    } catch (error) {
      // Still deny: failing to write the entry must not turn a rejection into an acceptance.
      this.logger.error({ err: error, action }, 'audit write failed for a denied request');
    }
  }
}
