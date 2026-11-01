import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  type CorrelationRule,
  type CreateCorrelationRule,
  type CreateHeartbeat,
  type Heartbeat,
  type UpdateCorrelationRule,
  type UpdateHeartbeat,
} from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, pgCode, pgConstraint } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

type HeartbeatRow = typeof schema.heartbeat.$inferSelect;
type RuleRow = typeof schema.correlationRule.$inferSelect;

function toHeartbeat(row: HeartbeatRow): Heartbeat {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    expectedIntervalSeconds: row.expectedIntervalSeconds,
    graceSeconds: row.graceSeconds,
    severity: row.severity as Heartbeat['severity'],
    serviceId: row.serviceId,
    active: row.active,
    state: row.state as Heartbeat['state'],
    lastBeatAt: row.lastBeatAt?.toISOString() ?? null,
    missingSince: row.missingSince?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRule(row: RuleRow): CorrelationRule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CorrelationRule['kind'],
    windowMinutes: row.windowMinutes,
    minAlerts: row.minAlerts,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function translate(error: unknown): never {
  const code = pgCode(error);
  const constraint = pgConstraint(error);
  if (code === PG.uniqueViolation) {
    if (constraint === 'heartbeat_slug_key') throw conflict('A heartbeat with this slug exists');
    if (constraint === 'correlation_rule_name_key') {
      throw conflict('A correlation rule with this name exists');
    }
    throw conflict('Already exists');
  }
  if (code === PG.foreignKeyViolation) throw badRequest('No such service');
  throw error;
}

/**
 * Heartbeats (R-3.10) and correlation rules (R-3.6): the lists a lead edits. Behaviour (what makes a
 * heartbeat missing, which alerts a rule groups) lives in `@watchtower/domain`; this is the catalog.
 * Every mutation writes its audit row in the same transaction.
 */
@Injectable()
export class AlertsHygiene {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // --- heartbeats ---------------------------------------------------------------------------

  async listHeartbeats(): Promise<Heartbeat[]> {
    const rows = await this.database.db
      .select()
      .from(schema.heartbeat)
      .orderBy(asc(schema.heartbeat.slug));
    return rows.map(toHeartbeat);
  }

  async createHeartbeat(input: CreateHeartbeat, actorId: string): Promise<Heartbeat> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [created] = await tx
          .insert(schema.heartbeat)
          .values({
            slug: input.slug,
            name: input.name,
            expectedIntervalSeconds: input.expectedIntervalSeconds,
            ...(input.graceSeconds === undefined ? {} : { graceSeconds: input.graceSeconds }),
            ...(input.severity === undefined ? {} : { severity: input.severity }),
            serviceId: input.serviceId ?? null,
            ...(input.active === undefined ? {} : { active: input.active }),
            // Created now, by the database clock: a new heartbeat has a full interval to be heard.
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .returning();
        if (created === undefined) throw new Error('heartbeat insert returned no row');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.heartbeatCreate,
          targetType: 'heartbeat',
          targetId: created.id,
          metadata: { slug: created.slug },
        });
        return created;
      });
      return toHeartbeat(row);
    } catch (error) {
      translate(error);
    }
  }

  async updateHeartbeat(id: string, input: UpdateHeartbeat, actorId: string): Promise<Heartbeat> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [updated] = await tx
          .update(schema.heartbeat)
          .set({
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.expectedIntervalSeconds === undefined
              ? {}
              : { expectedIntervalSeconds: input.expectedIntervalSeconds }),
            ...(input.graceSeconds === undefined ? {} : { graceSeconds: input.graceSeconds }),
            ...(input.severity === undefined ? {} : { severity: input.severity }),
            ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
            ...(input.active === undefined ? {} : { active: input.active }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.heartbeat.id, id))
          .returning();
        if (updated === undefined) throw notFound('No such heartbeat');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.heartbeatUpdate,
          targetType: 'heartbeat',
          targetId: id,
          metadata: { slug: updated.slug, fields: Object.keys(input).toSorted() },
        });
        return updated;
      });
      return toHeartbeat(row);
    } catch (error) {
      translate(error);
    }
  }

  async deleteHeartbeat(id: string, actorId: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const [deleted] = await tx
        .delete(schema.heartbeat)
        .where(eq(schema.heartbeat.id, id))
        .returning({ slug: schema.heartbeat.slug });
      if (deleted === undefined) throw notFound('No such heartbeat');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: ALERTS_AUDIT_ACTIONS.heartbeatDelete,
        targetType: 'heartbeat',
        targetId: id,
        metadata: { slug: deleted.slug },
      });
    });
  }

  // --- correlation rules --------------------------------------------------------------------

  async listRules(): Promise<CorrelationRule[]> {
    const rows = await this.database.db
      .select()
      .from(schema.correlationRule)
      .orderBy(asc(schema.correlationRule.name));
    return rows.map(toRule);
  }

  async createRule(input: CreateCorrelationRule, actorId: string): Promise<CorrelationRule> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [created] = await tx
          .insert(schema.correlationRule)
          .values({
            name: input.name,
            kind: input.kind ?? 'same_service',
            windowMinutes: input.windowMinutes,
            minAlerts: input.minAlerts,
            ...(input.active === undefined ? {} : { active: input.active }),
          })
          .returning();
        if (created === undefined) throw new Error('rule insert returned no row');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.correlationRuleCreate,
          targetType: 'correlation_rule',
          targetId: created.id,
          metadata: { windowMinutes: created.windowMinutes, minAlerts: created.minAlerts },
        });
        return created;
      });
      return toRule(row);
    } catch (error) {
      translate(error);
    }
  }

  async updateRule(
    id: string,
    input: UpdateCorrelationRule,
    actorId: string,
  ): Promise<CorrelationRule> {
    try {
      const row = await this.uow.run(async ({ tx }) => {
        const [updated] = await tx
          .update(schema.correlationRule)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.windowMinutes === undefined ? {} : { windowMinutes: input.windowMinutes }),
            ...(input.minAlerts === undefined ? {} : { minAlerts: input.minAlerts }),
            ...(input.active === undefined ? {} : { active: input.active }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.correlationRule.id, id))
          .returning();
        if (updated === undefined) throw notFound('No such correlation rule');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: ALERTS_AUDIT_ACTIONS.correlationRuleUpdate,
          targetType: 'correlation_rule',
          targetId: id,
          metadata: { fields: Object.keys(input).toSorted() },
        });
        return updated;
      });
      return toRule(row);
    } catch (error) {
      translate(error);
    }
  }

  async deleteRule(id: string, actorId: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const [deleted] = await tx
        .delete(schema.correlationRule)
        .where(eq(schema.correlationRule.id, id))
        .returning({ id: schema.correlationRule.id });
      if (deleted === undefined) throw notFound('No such correlation rule');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: ALERTS_AUDIT_ACTIONS.correlationRuleDelete,
        targetType: 'correlation_rule',
        targetId: id,
        metadata: {},
      });
    });
  }
}
