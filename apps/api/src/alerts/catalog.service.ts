import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  serviceMatchRuleSchema,
  type CreateEscalationPolicy,
  type CreateService,
  type EscalationPolicy,
  type EscalationStep,
  type Service,
  type UpdateEscalationPolicy,
  type UpdateService,
} from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, pgCode, pgConstraint } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

type ServiceRow = typeof schema.service.$inferSelect;
type PolicyRow = typeof schema.escalationPolicy.$inferSelect;

const matchRulesSchema = z.array(serviceMatchRuleSchema);

function toService(row: ServiceRow): Service {
  // A stored rule that no longer parses (the vocabulary of label keys changed) is shown as no rule
  // rather than failing the whole catalog; matching skips it the same way.
  const rules = matchRulesSchema.safeParse(row.matchRules);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ownerQueueId: row.ownerQueueId,
    runbookUrl: row.runbookUrl,
    runbookArticleId: row.runbookArticleId,
    dashboardUrl: row.dashboardUrl,
    matchRules: rules.success ? rules.data : [],
    repos: row.repos,
    escalationPolicyId: row.escalationPolicyId,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPolicy(row: PolicyRow): EscalationPolicy {
  return {
    id: row.id,
    name: row.name,
    steps: row.steps as EscalationStep[],
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Constraint violations of the catalog tables, as the API answers them. */
function translate(error: unknown): never {
  const code = pgCode(error);
  const constraint = pgConstraint(error);
  if (code === PG.uniqueViolation) {
    if (constraint === 'service_slug_key')
      throw conflict('A service with this slug already exists');
    if (constraint === 'escalation_policy_name_key') {
      throw conflict('An escalation policy with this name already exists');
    }
    throw conflict('Already exists');
  }
  if (code === PG.foreignKeyViolation) {
    if (constraint?.includes('owner_queue') === true) throw badRequest('No such team queue');
    if (constraint?.includes('escalation_policy') === true) {
      throw badRequest('No such escalation policy');
    }
    if (constraint?.includes('runbook_article') === true) {
      throw badRequest('No such knowledge base article');
    }
    throw badRequest('A referenced record does not exist');
  }
  throw error;
}

/**
 * The service catalog and the escalation policies (R-3.7, R-3.8): who owns a service, where its
 * runbook is, which alerts are its (`matchRules`) and who is told when it is not answered. Every
 * mutation writes its audit row in the same transaction. Nothing here touches an alert: deleting a
 * service or a policy un-maps instead (the foreign keys set null).
 */
@Injectable()
export class AlertsCatalog {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // --- services -----------------------------------------------------------------------------

  async listServices(): Promise<Service[]> {
    const rows = await this.database.db
      .select()
      .from(schema.service)
      .orderBy(asc(schema.service.slug));
    return rows.map(toService);
  }

  async getService(id: string): Promise<Service> {
    const [row] = await this.database.db
      .select()
      .from(schema.service)
      .where(eq(schema.service.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such service');
    return toService(row);
  }

  async createService(input: CreateService, actorId: string): Promise<Service> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [created] = await tx
          .insert(schema.service)
          .values({
            slug: input.slug,
            name: input.name,
            ownerQueueId: input.ownerQueueId ?? null,
            runbookUrl: input.runbookUrl ?? null,
            runbookArticleId: input.runbookArticleId ?? null,
            dashboardUrl: input.dashboardUrl ?? null,
            matchRules: input.matchRules ?? [],
            repos: input.repos ?? [],
            escalationPolicyId: input.escalationPolicyId ?? null,
            active: input.active ?? true,
          })
          .returning();
        if (created === undefined) throw new Error('service insert returned no row');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.serviceCreate,
          targetType: 'service',
          targetId: created.id,
          metadata: { slug: created.slug },
        });
        return created;
      });
      return toService(row);
    } catch (error) {
      translate(error);
    }
  }

  async updateService(id: string, input: UpdateService, actorId: string): Promise<Service> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [updated] = await tx
          .update(schema.service)
          .set({
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.ownerQueueId === undefined ? {} : { ownerQueueId: input.ownerQueueId }),
            ...(input.runbookUrl === undefined ? {} : { runbookUrl: input.runbookUrl }),
            ...(input.runbookArticleId === undefined
              ? {}
              : { runbookArticleId: input.runbookArticleId }),
            ...(input.dashboardUrl === undefined ? {} : { dashboardUrl: input.dashboardUrl }),
            ...(input.matchRules === undefined ? {} : { matchRules: input.matchRules }),
            ...(input.repos === undefined ? {} : { repos: input.repos }),
            ...(input.escalationPolicyId === undefined
              ? {}
              : { escalationPolicyId: input.escalationPolicyId }),
            ...(input.active === undefined ? {} : { active: input.active }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.service.id, id))
          .returning();
        if (updated === undefined) throw notFound('No such service');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.serviceUpdate,
          targetType: 'service',
          targetId: id,
          metadata: { slug: updated.slug, fields: Object.keys(input).toSorted() },
        });
        return updated;
      });
      return toService(row);
    } catch (error) {
      translate(error);
    }
  }

  async deleteService(id: string, actorId: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const [deleted] = await tx
        .delete(schema.service)
        .where(eq(schema.service.id, id))
        .returning({ slug: schema.service.slug });
      if (deleted === undefined) throw notFound('No such service');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: ALERTS_AUDIT_ACTIONS.serviceDelete,
        targetType: 'service',
        targetId: id,
        metadata: { slug: deleted.slug },
      });
    });
  }

  // --- escalation policies ------------------------------------------------------------------

  async listPolicies(): Promise<EscalationPolicy[]> {
    const rows = await this.database.db
      .select()
      .from(schema.escalationPolicy)
      .orderBy(asc(schema.escalationPolicy.name));
    return rows.map(toPolicy);
  }

  async createPolicy(input: CreateEscalationPolicy, actorId: string): Promise<EscalationPolicy> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [created] = await tx
          .insert(schema.escalationPolicy)
          .values({ name: input.name, steps: input.steps })
          .returning();
        if (created === undefined) throw new Error('policy insert returned no row');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.escalationPolicyCreate,
          targetType: 'escalation_policy',
          targetId: created.id,
          metadata: { steps: created.steps },
        });
        return created;
      });
      return toPolicy(row);
    } catch (error) {
      translate(error);
    }
  }

  async updatePolicy(
    id: string,
    input: UpdateEscalationPolicy,
    actorId: string,
  ): Promise<EscalationPolicy> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [updated] = await tx
          .update(schema.escalationPolicy)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.steps === undefined ? {} : { steps: input.steps }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.escalationPolicy.id, id))
          .returning();
        if (updated === undefined) throw notFound('No such escalation policy');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.escalationPolicyUpdate,
          targetType: 'escalation_policy',
          targetId: id,
          metadata: { fields: Object.keys(input).toSorted() },
        });
        return updated;
      });
      return toPolicy(row);
    } catch (error) {
      translate(error);
    }
  }

  async deletePolicy(id: string, actorId: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const [existing] = await tx
        .select({ isDefault: schema.escalationPolicy.isDefault })
        .from(schema.escalationPolicy)
        .where(eq(schema.escalationPolicy.id, id))
        .for('update')
        .limit(1);
      if (existing === undefined) throw notFound('No such escalation policy');
      if (existing.isDefault) throw conflict('The default escalation policy cannot be deleted');
      await tx.delete(schema.escalationPolicy).where(eq(schema.escalationPolicy.id, id));
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: ALERTS_AUDIT_ACTIONS.escalationPolicyDelete,
        targetType: 'escalation_policy',
        targetId: id,
        metadata: {},
      });
    });
  }
}
