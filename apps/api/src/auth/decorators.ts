import {
  SetMetadata,
  applyDecorators,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtension,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Permission } from '@watchtower/shared';
import type { Request } from 'express';

import { unauthenticated } from './http-errors.js';
import { principalOf, type Principal } from './principal.js';

export const PUBLIC_KEY = 'wt:public';
export const PERMISSIONS_KEY = 'wt:permissions';
export const ANY_PERMISSIONS_KEY = 'wt:permissions-any';
export const AUDIT_KEY = 'wt:audit';
export const WORKSPACE_ONLY_KEY = 'wt:workspace-only';

/** Name of the cookie security scheme in the OpenAPI document. */
export const COOKIE_AUTH_SCHEME = 'cookie';

/**
 * Opts a route out of authentication. The default for every route is "denied": a route with
 * neither `@Public()` nor a permission decorator answers 403 even to a signed-in head.
 */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC_KEY, true);

/**
 * Only people who work inside the workspace (agent, lead, head, dev) may call the route. The guard refuses `client`
 * and `system` with 403 BEFORE it looks at permissions, so granting a permission to either role (a head can, through
 * `rbac.manage`) opens nothing. Put it on the whole controller (ADR-029 section 1: every `/v1/assistant/**`).
 */
export const WorkspaceOnly = (): CustomDecorator => SetMetadata(WORKSPACE_ONLY_KEY, true);

const secured = (extension: readonly Permission[]) =>
  applyDecorators(
    ApiCookieAuth(COOKIE_AUTH_SCHEME),
    ApiExtension('x-required-permissions', [...extension]),
    ApiUnauthorizedResponse({ description: 'Not signed in (code unauthenticated)' }),
    ApiForbiddenResponse({
      description:
        'Missing permission, or CSRF token missing or wrong (code forbidden, csrf_invalid)',
    }),
  );

/** The caller must have every listed permission. Put it on a route or a whole controller. */
export const RequirePermission = (
  ...permissions: readonly [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(PERMISSIONS_KEY, permissions), secured(permissions));

/** The caller must have at least one of the listed permissions (the service narrows further). */
export const RequireAnyPermission = (
  ...permissions: readonly [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(ANY_PERMISSIONS_KEY, permissions), secured(permissions));

export interface AuditedOptions {
  /** Audit action name, for example `user.create`. Handlers may override it per call. */
  readonly action: string;
  readonly targetType?: string;
  /** Audit this route even though it is a GET (reads of PII, sign-in callbacks). */
  readonly always?: boolean;
}

/**
 * Names the audit action of a mutating route. Every POST/PUT/PATCH/DELETE is audited whether or
 * not it carries this decorator (unnamed ones get `http.<METHOD> <path>`); the decorator gives it
 * a stable name and target type.
 */
export const Audited = (options: AuditedOptions): CustomDecorator =>
  SetMetadata(AUDIT_KEY, options);

/** Action recorded when a route returns personal data. T-005 puts it on contact/ticket reads. */
export const PII_READ_ACTION = 'pii.read';

/**
 * Marks a GET that returns PII-bearing records, so the read is written to the audit log
 * (PRD section 8.2). The handler sets the target with `AuditScope.set({ targetId })`.
 */
export const AuditPiiRead = (targetType: string): CustomDecorator =>
  Audited({ action: PII_READ_ACTION, targetType, always: true });

/** The authenticated caller. Only valid on routes guarded by a permission. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = principalOf(context.switchToHttp().getRequest<Request>());
    if (!principal) throw unauthenticated();
    return principal;
  },
);

export type { Principal };
