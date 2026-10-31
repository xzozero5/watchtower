import type { OrgScope } from '@watchtower/shared';
import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * WHERE fragment that limits an organization-scoped table to what the caller may see.
 *
 *   db.select().from(tickets).where(and(orgScopeCondition(tickets.orgId, principal.orgScope), ...))
 *
 * Staff scope returns undefined, which `and()`/`where()` ignore; a client scope returns
 * `org_id = <their org>`. Every read and write path of a client-visible table must go through it
 * (docs/04-ARCHITECTURE.md section 7); the RBAC e2e in T-009 checks that no path forgets.
 */
export function orgScopeCondition(column: PgColumn, scope: OrgScope): SQL | undefined {
  return scope.kind === 'all' ? undefined : eq(column, scope.orgId);
}
