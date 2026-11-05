import { HttpException, Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  INSIGHT_ELEMENTS,
  isInsightElementKey,
  WORKSPACE_ROLES,
  type InsightElement,
  type Permission,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { inReadOnlyScope, runReadOnly } from '../assistant/read-only.js';
import type { Principal } from '../auth/principal.js';
import { evaluatePermissionRule } from '../auth/permission-check.js';
import { DATABASE } from '../database/database.module.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { IntentsService } from '../intents/intents.service.js';
import { OrganizationsService } from '../orgs/organizations.service.js';
import { parseScopeKey, scopeKeyFor } from './insight-scope.js';

/** What a viewer's rights decide; the minimum a checker needs of a principal. */
export type InsightViewer = Pick<Principal, 'userId' | 'role' | 'permissions'>;

/**
 * Whether the viewer satisfies the rule of the element: the same evaluator the guard uses for the element's GET
 * route (ADR-029 section 9.3, T-400 C-1). A client or a system identity never does, whatever they were granted.
 */
export function insightRuleAllows(viewer: InsightViewer, element: InsightElement): boolean {
  if (!(WORKSPACE_ROLES as readonly string[]).includes(viewer.role)) return false;
  return element.rule !== null && evaluatePermissionRule(viewer, element.rule);
}

/** Which of the permissions the viewer holds (for a rule of `anyOf` shape that names several kinds of read). */
const holdsAny = (viewer: InsightViewer, permissions: readonly Permission[]): boolean =>
  permissions.some((permission) => viewer.permissions.has(permission));

/** Statuses a module answers with for a thing that is missing or not the caller's: both mean "not for you". */
const REFUSALS = new Set([403, 404]);

async function refusedAsFalse(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    if (error instanceof HttpException && REFUSALS.has(error.getStatus())) return false;
    throw error;
  }
}

/**
 * The one answer to "may this person see the insight of this element for this scope?" (ADR-029 section 9.3, T-416
 * C-18): the rule of the element's GET route through the shared evaluator, AND the scope resolver (a row scope is
 * read with the reader of its own module under the person's principal, in the read-only scope). `GET /v1/insights`
 * uses it for every element, and the feedback endpoint of T-408 uses it before it accepts a 👍/👎.
 */
@Injectable()
export class InsightAccess {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
    @Inject(IntentsService) private readonly intents: IntentsService,
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
  ) {}

  /** True when the scope of the key is one the viewer may read (the rule of the element is not looked at). */
  async canReadScope(viewer: Principal, scopeKey: string): Promise<boolean> {
    const scope = parseScopeKey(scopeKey);
    if (scope === null) return false;
    switch (scope.kind) {
      case 'instance':
        return true;
      case 'user':
        // The viewer's own: there is no key for anybody else's.
        return true;
      case 'org':
        if (!holdsAny(viewer, ['ticket.read', 'ticket.read.org', 'org.health.read'])) return false;
        return inReadOnlyScope(() => refusedAsFalse(() => this.orgs.get(scope.id, viewer)));
      case 'intent':
        if (!holdsAny(viewer, ['ticket.read'])) return false;
        return inReadOnlyScope(() => refusedAsFalse(() => this.intents.get(scope.id)));
      case 'incident':
        if (!holdsAny(viewer, ['ticket.read'])) return false;
        return inReadOnlyScope(() => refusedAsFalse(() => this.incidents.getRow(scope.id)));
      case 'service': {
        if (!holdsAny(viewer, ['alert.read', 'ticket.read'])) return false;
        const rows = await runReadOnly(this.database, (db) =>
          db
            .select({ id: schema.service.id })
            .from(schema.service)
            .where(eq(schema.service.id, scope.id))
            .limit(1),
        );
        return rows.length > 0;
      }
    }
  }

  /**
   * `canViewInsight(principal, element, scopeKey)`: the element is shown to a person when they satisfy its rule AND
   * the scope is one they may read AND `scopeKey` is of the kind the element has. An unknown element, a scope of the
   * wrong kind and a scope that does not exist all answer false, the same way.
   */
  async canViewInsight(principal: Principal, element: string, scopeKey: string): Promise<boolean> {
    if (!isInsightElementKey(element)) return false;
    const row = INSIGHT_ELEMENTS[element];
    if (row.mode === 'X') return false;
    if (!insightRuleAllows(principal, row)) return false;
    if (scopeKeyFor(row, scopeKey) === null) return false;
    return this.canReadScope(principal, scopeKey);
  }
}
