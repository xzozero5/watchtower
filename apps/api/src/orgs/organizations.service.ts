import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import type {
  CreateOrganization,
  Organization,
  OrganizationListQuery,
  OrgTier,
  UpdateOrganization,
} from '@watchtower/shared';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { assertOrgAccess, type Principal } from '../auth/principal.js';
import { PG, isPgError } from '../common/db-errors.js';
import {
  beforeCursor,
  decodeCursor,
  likeContains,
  preciseTimestamp,
  toPage,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';

export type OrganizationRow = typeof schema.organization.$inferSelect;

export function toApiOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier as OrgTier,
    slaPolicyId: row.slaPolicyId,
    domains: row.domains,
    lineGroupIds: row.lineGroupIds,
    healthScore: row.healthScore,
    primaryContactId: row.primaryContactId,
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
    return {
      items: page.rows.map((entry) => toApiOrganization(entry.row)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string, principal: Principal): Promise<Organization> {
    const row = await this.find(id);
    if (!row) throw notFound('No such organization');
    assertOrgAccess(principal, row.id);
    return toApiOrganization(row);
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
      return toApiOrganization(row);
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
      return toApiOrganization(row);
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
      return badRequest('slaPolicyId does not refer to an SLA policy');
    }
    return error;
  }
}
