import { schema } from '@watchtower/db';
import {
  STATUSPAGE_AUDIT_ACTIONS,
  createStatusComponentSchema,
  updateStatusComponentSchema,
  type CreateStatusComponent,
  type UpdateStatusComponent,
} from '@watchtower/shared';
import { eq, inArray, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

/** Only a person, and one who is signed in, changes what the page lists. */
export function requirePerson(ctx: DomainContext, what: string): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', `Only a person can ${what}`, {
      reason: 'human_required',
    });
  }
  return ctx.actor.id;
}

/** The ids must all name components; returns them without repeats, in the order given. */
export async function assertComponentsExist(
  tx: DbTransaction,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const found = await tx
    .select({ id: schema.statusComponent.id })
    .from(schema.statusComponent)
    .where(inArray(schema.statusComponent.id, unique));
  if (found.length !== unique.length) throw badRequest('A component does not exist');
  return unique;
}

const snapshot = (row: typeof schema.statusComponent.$inferSelect) => ({
  slug: row.slug,
  name: row.name,
  public: row.public,
  status: row.status,
  serviceId: row.serviceId,
  position: row.position,
});

async function assertServiceExists(tx: DbTransaction, serviceId: string | null): Promise<void> {
  if (serviceId === null) return;
  const [service] = await tx
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(eq(schema.service.id, serviceId))
    .limit(1);
  if (service === undefined) throw badRequest('serviceId does not name a service');
}

export async function createStatusComponent(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateStatusComponent,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  requirePerson(ctx, 'change the status page');
  const parsed = createStatusComponentSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The component is not valid');
  await assertServiceExists(tx, parsed.data.serviceId);
  const [taken] = await tx
    .select({ id: schema.statusComponent.id })
    .from(schema.statusComponent)
    .where(eq(schema.statusComponent.slug, parsed.data.slug))
    .limit(1);
  if (taken !== undefined) throw conflict('A component with this slug exists');
  const [row] = await tx.insert(schema.statusComponent).values(parsed.data).returning();
  if (row === undefined) throw new Error('status_component insert returned no row');
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.componentCreate,
    targetType: 'status_component',
    targetId: row.id,
    after: snapshot(row),
  });
  return fx.result({ id: row.id });
}

export async function updateStatusComponent(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
  input: UpdateStatusComponent,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  requirePerson(ctx, 'change the status page');
  const parsed = updateStatusComponentSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The change is not valid');
  const [before] = await tx
    .select()
    .from(schema.statusComponent)
    .where(eq(schema.statusComponent.id, id))
    .for('update')
    .limit(1);
  if (before === undefined) throw notFound('No such component');
  if (parsed.data.serviceId !== undefined) await assertServiceExists(tx, parsed.data.serviceId);
  const [after] = await tx
    .update(schema.statusComponent)
    .set({ ...parsed.data, updatedAt: sql`clock_timestamp()` })
    .where(eq(schema.statusComponent.id, id))
    .returning();
  if (after === undefined) throw new Error('status_component update returned no row');
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.componentUpdate,
    targetType: 'status_component',
    targetId: id,
    before: snapshot(before),
    after: snapshot(after),
  });
  return fx.result({ id });
}

export async function deleteStatusComponent(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
): Promise<DomainResult<{ readonly deleted: boolean }>> {
  const fx = new Effects();
  requirePerson(ctx, 'change the status page');
  const [row] = await tx
    .delete(schema.statusComponent)
    .where(eq(schema.statusComponent.id, id))
    .returning();
  if (row === undefined) return fx.result({ deleted: false });
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.componentDelete,
    targetType: 'status_component',
    targetId: id,
    before: snapshot(row),
  });
  return fx.result({ deleted: true });
}
