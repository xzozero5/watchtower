import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import {
  DEFAULT_ORG_TIER,
  type CreateOrgTier,
  type CreateOrganization,
  type OrgScope,
  type Organization,
  type OrganizationListQuery,
  type OrgTierRecord,
  type UpdateOrgTier,
  type UpdateOrganization,
} from '@watchtower/shared';
import { and, asc, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { assertOrgAccess, type Principal } from '../auth/principal.js';
import { PG, isPgError, pgConstraint } from '../common/db-errors.js';
import {
  beforeCursor,
  decodeCursor,
  likeContains,
  preciseTimestamp,
  toPage,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';

export type OrganizationRow = typeof schema.organization.$inferSelect;

export function toApiOrganization(row: OrganizationRow, contactCount: number | null): Organization {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    slaPolicyId: row.slaPolicyId,
    domains: row.domains,
    lineGroupIds: row.lineGroupIds,
    healthScore: row.healthScore,
    primaryContactId: row.primaryContactId,
    contactCount,
    notes: row.notes,
    status: row.status === 'inactive' ? 'inactive' : 'active',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What an audit entry records about an organization. */
function snapshot(row: OrganizationRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    slaPolicyId: row.slaPolicyId,
    domains: row.domains,
    status: row.status,
    primaryContactId: row.primaryContactId,
  };
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Staff list every organization; a client lists exactly their own. */
  async list(
    query: OrganizationListQuery,
    principal: Principal,
  ): Promise<{ items: Organization[]; nextCursor: string | null }> {
    const { organization } = schema;
    const rows = await this.database.db
      .select({ row: organization, sortKey: preciseTimestamp(organization.createdAt) })
      .from(organization)
      .where(
        and(
          orgScopeCondition(organization.id, principal.orgScope),
          query.status === undefined ? undefined : eq(organization.status, query.status),
          query.q === undefined ? undefined : ilike(organization.name, likeContains(query.q)),
          query.cursor === undefined
            ? undefined
            : beforeCursor(organization.createdAt, organization.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(organization.createdAt), desc(organization.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ ...entry, id: entry.row.id })),
      query.limit,
    );
    const counts = await this.contactCounts(
      page.rows.map((entry) => entry.row.id),
      principal.orgScope,
    );
    return {
      items: page.rows.map((entry) =>
        toApiOrganization(entry.row, counts.get(entry.row.id) ?? null),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Contacts per organization, one grouped query for the whole page (index `contact_org_idx`).
   * A client gets none: the count is for staff, and the map is empty so every value reads null.
   */
  async contactCounts(
    orgIds: readonly string[],
    scope: OrgScope,
  ): Promise<ReadonlyMap<string, number>> {
    if (scope.kind === 'org' || orgIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ orgId: schema.contact.orgId, n: count() })
      .from(schema.contact)
      .where(inArray(schema.contact.orgId, [...orgIds]))
      .groupBy(schema.contact.orgId);
    const counts = new Map<string, number>(orgIds.map((id) => [id, 0]));
    for (const row of rows) counts.set(row.orgId, row.n);
    return counts;
  }

  /** The tiers an organization or an SLA policy may name, in display order (T-127; editing is T-121). */
  async tiers(): Promise<OrgTierRecord[]> {
    const rows = await this.database.db
      .select()
      .from(schema.orgTier)
      .orderBy(asc(schema.orgTier.sortOrder), asc(schema.orgTier.slug));
    return rows.map((row) => ({ slug: row.slug, name: row.name, sortOrder: row.sortOrder }));
  }

  /** Adds a tier (T-121b). A slug is what organizations and SLA policies name, so it is unique. */
  async createTier(input: CreateOrgTier): Promise<OrgTierRecord> {
    try {
      const [row] = await this.database.db
        .insert(schema.orgTier)
        .values({ slug: input.slug, name: input.name, sortOrder: input.sortOrder })
        .returning();
      if (!row) throw new Error('org_tier insert returned no row');
      const record = { slug: row.slug, name: row.name, sortOrder: row.sortOrder };
      AuditScope.set({ targetType: 'org_tier', targetId: row.slug, after: record });
      return record;
    } catch (error) {
      if (isPgError(error, PG.uniqueViolation)) throw conflict('That tier already exists');
      throw error;
    }
  }

  /**
   * Renames or reorders a tier. A new slug is followed by every organization and SLA policy that names
   * it (the database cascades it). The default tier keeps its slug: new organizations start in it.
   */
  async updateTier(slug: string, patch: UpdateOrgTier): Promise<OrgTierRecord> {
    const [before] = await this.database.db
      .select()
      .from(schema.orgTier)
      .where(eq(schema.orgTier.slug, slug))
      .limit(1);
    if (!before) throw notFound('No such tier');
    const beforeRecord = { slug: before.slug, name: before.name, sortOrder: before.sortOrder };
    AuditScope.set({ targetType: 'org_tier', targetId: slug, before: beforeRecord });
    if (patch.slug !== undefined && patch.slug !== slug && slug === DEFAULT_ORG_TIER) {
      throw conflict(
        `The default tier "${DEFAULT_ORG_TIER}" keeps its slug; rename its display name instead`,
      );
    }
    try {
      const [row] = await this.database.db
        .update(schema.orgTier)
        .set({
          ...(patch.slug === undefined ? {} : { slug: patch.slug }),
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
        })
        .where(eq(schema.orgTier.slug, slug))
        .returning();
      if (!row) throw notFound('No such tier');
      const record = { slug: row.slug, name: row.name, sortOrder: row.sortOrder };
      AuditScope.set({ targetId: row.slug, after: record });
      return record;
    } catch (error) {
      if (isPgError(error, PG.uniqueViolation)) throw conflict('That tier already exists');
      throw error;
    }
  }

  /** Removes a tier nobody uses: refused (409) while an organization or an SLA policy still names it. */
  async deleteTier(slug: string): Promise<void> {
    const [before] = await this.database.db
      .select()
      .from(schema.orgTier)
      .where(eq(schema.orgTier.slug, slug))
      .limit(1);
    if (!before) throw notFound('No such tier');
    AuditScope.set({
      targetType: 'org_tier',
      targetId: slug,
      before: { slug: before.slug, name: before.name, sortOrder: before.sortOrder },
    });
    if (slug === DEFAULT_ORG_TIER) {
      throw conflict(
        `The default tier "${DEFAULT_ORG_TIER}" cannot be deleted: new organizations start in it`,
      );
    }
    try {
      await this.database.db.delete(schema.orgTier).where(eq(schema.orgTier.slug, slug));
    } catch (error) {
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict('An organization or an SLA policy still uses this tier');
      }
      throw error;
    }
  }

  async get(id: string, principal: Principal): Promise<Organization> {
    const row = await this.find(id);
    if (!row) throw notFound('No such organization');
    assertOrgAccess(principal, row.id);
    const counts = await this.contactCounts([row.id], principal.orgScope);
    return toApiOrganization(row, counts.get(row.id) ?? null);
  }

  async find(id: string): Promise<OrganizationRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, id))
      .limit(1);
    return row;
  }

  async create(input: CreateOrganization): Promise<Organization> {
    try {
      const [row] = await this.database.db
        .insert(schema.organization)
        .values({
          name: input.name,
          tier: input.tier,
          slaPolicyId: input.slaPolicyId ?? null,
          domains: input.domains,
          lineGroupIds: input.lineGroupIds,
          notes: input.notes,
        })
        .returning();
      if (!row) throw new Error('organization insert returned no row');
      AuditScope.set({ targetType: 'organization', targetId: row.id, after: snapshot(row) });
      return toApiOrganization(row, 0);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, patch: UpdateOrganization): Promise<Organization> {
    const before = await this.find(id);
    if (!before) throw notFound('No such organization');
    AuditScope.set({ targetType: 'organization', targetId: id, before: snapshot(before) });

    if (patch.primaryContactId !== undefined && patch.primaryContactId !== null) {
      const [contact] = await this.database.db
        .select({ orgId: schema.contact.orgId })
        .from(schema.contact)
        .where(eq(schema.contact.id, patch.primaryContactId))
        .limit(1);
      if (contact?.orgId !== id) {
        throw badRequest('The primary contact must be a contact of this organization');
      }
    }
    try {
      const [row] = await this.database.db
        .update(schema.organization)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.tier === undefined ? {} : { tier: patch.tier }),
          ...(patch.slaPolicyId === undefined ? {} : { slaPolicyId: patch.slaPolicyId }),
          ...(patch.domains === undefined ? {} : { domains: patch.domains }),
          ...(patch.lineGroupIds === undefined ? {} : { lineGroupIds: patch.lineGroupIds }),
          ...(patch.healthScore === undefined ? {} : { healthScore: patch.healthScore }),
          ...(patch.primaryContactId === undefined
            ? {}
            : { primaryContactId: patch.primaryContactId }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.organization.id, id))
        .returning();
      if (!row) throw notFound('No such organization');
      AuditScope.set({ after: snapshot(row) });
      const counts = await this.contactCounts([row.id], { kind: 'all' });
      return toApiOrganization(row, counts.get(row.id) ?? 0);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async remove(id: string): Promise<void> {
    const before = await this.find(id);
    if (!before) throw notFound('No such organization');
    AuditScope.set({ targetType: 'organization', targetId: id, before: snapshot(before) });
    try {
      await this.database.db.delete(schema.organization).where(eq(schema.organization.id, id));
    } catch (error) {
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict(
          'The organization still has contacts, users or tickets; set it to inactive instead',
        );
      }
      throw error;
    }
  }

  private translate(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation)) {
      return conflict('A domain of this organization already belongs to another organization');
    }
    if (isPgError(error, PG.foreignKeyViolation)) {
      return pgConstraint(error) === 'organization_tier_fkey'
        ? badRequest('tier is not a known tier')
        : badRequest('slaPolicyId does not refer to an SLA policy');
    }
    return error;
  }
}
