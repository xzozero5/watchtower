import { schema } from '@watchtower/db';
import {
  QUEUE_NAMES,
  STATUSPAGE_AUDIT_ACTIONS,
  STATUSPAGE_JOBS,
  createStatusMaintenanceSchema,
  updateStatusMaintenanceSchema,
  type CreateStatusMaintenance,
  type UpdateStatusMaintenance,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { assertComponentsExist, requirePerson } from './components.js';

function drafterOrigin(ctx: DomainContext): 'human' | 'ai' {
  if (ctx.actor.type === 'user' && ctx.actor.id !== null) return 'human';
  if (ctx.actor.type === 'ai') return 'ai';
  throw new DomainError('policy_denied', 'Only a person or the AI can draft a maintenance window', {
    reason: 'drafter_required',
  });
}

const NOTIFY_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** A draft window; invisible to the public until a person publishes it (N3). */
export async function draftStatusMaintenance(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateStatusMaintenance,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  const origin = drafterOrigin(ctx);
  const parsed = createStatusMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The maintenance window is not valid');
  const data = parsed.data;
  const componentIds = await assertComponentsExist(tx, data.componentIds);
  const [row] = await tx
    .insert(schema.statusMaintenance)
    .values({
      title: data.title,
      body: data.body,
      startsAt: new Date(data.startsAt),
      endsAt: new Date(data.endsAt),
      origin,
      draftedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
    })
    .returning({ id: schema.statusMaintenance.id });
  if (row === undefined) throw new Error('status_maintenance insert returned no row');
  if (componentIds.length > 0) {
    await tx
      .insert(schema.statusMaintenanceComponent)
      .values(componentIds.map((componentId) => ({ maintenanceId: row.id, componentId })));
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.maintenanceDraft,
    targetType: 'status_maintenance',
    targetId: row.id,
    metadata: { origin, components: componentIds.length },
  });
  return fx.result({ id: row.id });
}

export async function updateStatusMaintenance(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
  input: UpdateStatusMaintenance,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  drafterOrigin(ctx);
  const parsed = updateStatusMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The change is not valid');
  const [row] = await tx
    .select()
    .from(schema.statusMaintenance)
    .where(eq(schema.statusMaintenance.id, id))
    .for('update')
    .limit(1);
  if (row === undefined) throw notFound('No such maintenance window');
  if (row.state === 'cancelled') throw conflict('A cancelled window cannot be changed');
  if (row.state === 'published') requirePerson(ctx, 'change a published maintenance window');
  const { componentIds, startsAt, endsAt, ...columns } = parsed.data;
  const nextStart = startsAt === undefined ? row.startsAt : new Date(startsAt);
  const nextEnd = endsAt === undefined ? row.endsAt : new Date(endsAt);
  if (nextEnd.getTime() <= nextStart.getTime()) {
    throw badRequest('The window must end after it starts');
  }
  await tx
    .update(schema.statusMaintenance)
    .set({ ...columns, startsAt: nextStart, endsAt: nextEnd, updatedAt: sql`clock_timestamp()` })
    .where(eq(schema.statusMaintenance.id, id));
  if (componentIds !== undefined) {
    const unique = await assertComponentsExist(tx, componentIds);
    await tx
      .delete(schema.statusMaintenanceComponent)
      .where(eq(schema.statusMaintenanceComponent.maintenanceId, id));
    if (unique.length > 0) {
      await tx
        .insert(schema.statusMaintenanceComponent)
        .values(unique.map((componentId) => ({ maintenanceId: id, componentId })));
    }
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.maintenanceUpdate,
    targetType: 'status_maintenance',
    targetId: id,
    metadata: { fields: Object.keys(parsed.data), published: row.state === 'published' },
  });
  return fx.result({ id });
}

/** Publishes a window (N3): a person presses; the subscribers are told once, after the commit. */
export async function publishStatusMaintenance(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
): Promise<DomainResult<{ readonly subscribers: number }>> {
  const fx = new Effects();
  const personId = requirePerson(ctx, 'publish a maintenance window');
  const [row] = await tx
    .select({ state: schema.statusMaintenance.state })
    .from(schema.statusMaintenance)
    .where(eq(schema.statusMaintenance.id, id))
    .for('update')
    .limit(1);
  if (row === undefined) throw notFound('No such maintenance window');
  if (row.state !== 'draft') throw conflict(`This window is already ${row.state}`);
  await tx
    .update(schema.statusMaintenance)
    .set({
      state: 'published',
      publishedBy: personId,
      publishedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.statusMaintenance.id, id));
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.statusSubscription)
    .where(eq(schema.statusSubscription.state, 'confirmed'));
  const subscribers = count?.n ?? 0;
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.statuspage,
    name: STATUSPAGE_JOBS.notify,
    jobId: `status-notify-maintenance-${id}`,
    payload: { kind: 'maintenance', refId: id },
    options: NOTIFY_OPTIONS,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.maintenancePublish,
    targetType: 'status_maintenance',
    targetId: id,
    metadata: { subscribers },
  });
  return fx.result({ subscribers });
}

/** Cancels a window (a draft is dropped from view, a published one disappears from the page). */
export async function cancelStatusMaintenance(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
): Promise<DomainResult<{ readonly cancelled: boolean }>> {
  const fx = new Effects();
  requirePerson(ctx, 'cancel a maintenance window');
  const [row] = await tx
    .select({ state: schema.statusMaintenance.state })
    .from(schema.statusMaintenance)
    .where(eq(schema.statusMaintenance.id, id))
    .for('update')
    .limit(1);
  if (row === undefined) throw notFound('No such maintenance window');
  if (row.state === 'cancelled') return fx.result({ cancelled: false });
  await tx
    .update(schema.statusMaintenance)
    .set({ state: 'cancelled', cancelledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(eq(schema.statusMaintenance.id, id));
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.maintenanceCancel,
    targetType: 'status_maintenance',
    targetId: id,
    metadata: { was: row.state },
  });
  return fx.result({ cancelled: true });
}
