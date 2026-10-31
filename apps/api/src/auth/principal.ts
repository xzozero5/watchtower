import type { AuthMethod, OrgScope, Permission, Role } from '@watchtower/shared';
import type { Request } from 'express';

import { notFound } from './http-errors.js';

/** The authenticated caller of a request. Built by AuthGuard from the access cookie and the database. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  /** The one organization a client belongs to; null for staff and system identities. */
  readonly orgId: string | null;
  readonly authMethod: AuthMethod;
  /** When the access token behind this request stops being accepted. */
  readonly accessExpiresAt: Date;
  readonly permissions: ReadonlySet<Permission>;
  /** What the caller may see in organization-scoped tables. Hand it to `orgScopeCondition`. */
  readonly orgScope: OrgScope;
}

export function orgScopeFor(role: Role, orgId: string | null): OrgScope {
  if (role === 'client') {
    // A client row always has an org (database check); fail closed if it ever does not.
    if (orgId === null) throw new Error('client user without an organization');
    return { kind: 'org', orgId };
  }
  return { kind: 'all' };
}

/** True when the principal may touch data of `orgId`. Staff may touch every organization. */
export function canAccessOrg(principal: Principal, orgId: string): boolean {
  return principal.orgScope.kind === 'all' || principal.orgScope.orgId === orgId;
}

/**
 * Throws 404 (not 403) when a client asks for another organization's record, so a client cannot
 * tell which ids exist. Call it after loading a record by id, before returning it.
 */
export function assertOrgAccess(principal: Principal, orgId: string): void {
  if (!canAccessOrg(principal, orgId)) throw notFound();
}

const principals = new WeakMap<Request, Principal>();

export function attachPrincipal(request: Request, principal: Principal): void {
  principals.set(request, principal);
}

export function principalOf(request: Request): Principal | undefined {
  return principals.get(request);
}
