import { schema } from '@watchtower/db';
import {
  USAGE_AUDIT_ACTIONS,
  createMetricSchema,
  metricTemplateProblem,
  updateMetricSchema,
  type CreateMetric,
  type UpdateMetric,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { templateHash } from './dims.js';

/** A metric is SQL against product data: a signed-in person writes it (the API asks for `metric.manage`, a head). */
function requirePerson(ctx: DomainContext): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', 'Only a person can change a metric definition', {
      reason: 'human_required',
    });
  }
  return ctx.actor.id;
}

/** Creates a metric. The audit row carries the hash of the template, not the SQL. */
export async function createUsageMetric(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateMetric,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  const personId = requirePerson(ctx);
  const parsed = createMetricSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The metric is not valid');
  const data = parsed.data;
  const [taken] = await tx
    .select({ id: schema.usageMetricDef.id })
    .from(schema.usageMetricDef)
    .where(eq(schema.usageMetricDef.key, data.key))
    .limit(1);
  if (taken !== undefined) throw conflict('A metric with this key exists');
  const [row] = await tx
    .insert(schema.usageMetricDef)
    .values({
      key: data.key,
      name: data.name,
      description: data.description,
      sqlTemplate: data.sqlTemplate,
      dims: data.dims,
      unit: data.unit,
      refreshIntervalSeconds: data.refreshIntervalSeconds,
      direction: data.direction,
      anomalyRatio: String(data.anomalyRatio),
      anomalyMinAbs: String(data.anomalyMinAbs),
      active: data.active,
      createdBy: personId,
      updatedBy: personId,
    })
    .returning({ id: schema.usageMetricDef.id });
  if (row === undefined) throw new Error('usage_metric_def insert returned no row');
  await recordAuditInTx(tx, ctx, fx, {
    action: USAGE_AUDIT_ACTIONS.metricCreate,
    targetType: 'usage_metric',
    targetId: row.id,
    metadata: {
      key: data.key,
      dims: data.dims,
      templateSha256: templateHash(data.sqlTemplate),
      version: 1,
    },
  });
  return fx.result({ id: row.id });
}

/**
 * Edits a metric. A change of the SQL template is its own audit action with the hash of the old and of
 * the new text and the new version; it also clears the last run, so the next run reads the whole backfill
 * window again under the new template. A change of the declared dimensions does the same, since the series
 * keys change with it.
 */
export async function updateUsageMetric(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
  input: UpdateMetric,
): Promise<DomainResult<{ readonly id: string; readonly templateVersion: number }>> {
  const fx = new Effects();
  const personId = requirePerson(ctx);
  const parsed = updateMetricSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The change is not valid');
  const patch = parsed.data;
  if (patch.sqlTemplate !== undefined) {
    const problem = metricTemplateProblem(patch.sqlTemplate);
    if (problem !== null) throw badRequest(problem);
  }
  const [before] = await tx
    .select()
    .from(schema.usageMetricDef)
    .where(eq(schema.usageMetricDef.id, id))
    .for('update')
    .limit(1);
  if (before === undefined) throw notFound('No such metric');

  const templateChanged = patch.sqlTemplate !== undefined && patch.sqlTemplate !== before.sqlTemplate;
  const dimsChanged =
    patch.dims !== undefined && JSON.stringify(patch.dims) !== JSON.stringify(before.dims);
  const nextVersion = before.templateVersion + (templateChanged ? 1 : 0);
  const { anomalyRatio, anomalyMinAbs, ...rest } = patch;
  const [after] = await tx
    .update(schema.usageMetricDef)
    .set({
      ...rest,
      ...(anomalyRatio === undefined ? {} : { anomalyRatio: String(anomalyRatio) }),
      ...(anomalyMinAbs === undefined ? {} : { anomalyMinAbs: String(anomalyMinAbs) }),
      templateVersion: nextVersion,
      ...(templateChanged || dimsChanged
        ? { lastRunAt: null, lastRunState: null, lastRunError: null, lastRunPoints: null }
        : {}),
      updatedBy: personId,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.usageMetricDef.id, id))
    .returning();
  if (after === undefined) throw new Error('usage_metric_def update returned no row');

  await recordAuditInTx(tx, ctx, fx, {
    action: templateChanged ? USAGE_AUDIT_ACTIONS.metricTemplateEdit : USAGE_AUDIT_ACTIONS.metricUpdate,
    targetType: 'usage_metric',
    targetId: id,
    metadata: {
      key: before.key,
      fields: Object.keys(patch).filter((field) => field !== 'sqlTemplate'),
      ...(templateChanged
        ? {
            templateChanged: true,
            fromSha256: templateHash(before.sqlTemplate),
            toSha256: templateHash(after.sqlTemplate),
            version: nextVersion,
          }
        : {}),
      dimsChanged,
    },
  });
  return fx.result({ id, templateVersion: nextVersion });
}
