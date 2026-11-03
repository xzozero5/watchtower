import { schema } from '@watchtower/db';
import {
  INCIDENTS_AUDIT_ACTIONS,
  INCIDENTS_JOBS,
  INCIDENTS_OUTBOX_JOB_OPTIONS,
  INCIDENTS_TICKET_EVENTS,
  QUEUE_NAMES,
  createIncidentSchema,
  formatIncidentKey,
  incidentStatusAllows,
  incidentNoteSchema,
  updateIncidentSchema,
  type CreateIncident,
  type IncidentStatus,
  type UpdateIncident,
} from '@watchtower/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, conflict, invalidTransition, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { recordTicketEvent } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { dbNow } from '../alerts/clock.js';
import { addTimelineEntry } from './timeline.js';

type IncidentRow = typeof schema.incident.$inferSelect;

export interface IncidentRef {
  readonly incidentId: string;
  readonly key: string;
}

async function lockIncident(tx: DbTransaction, incidentId: string): Promise<IncidentRow> {
  const [row] = await tx
    .select()
    .from(schema.incident)
    .where(eq(schema.incident.id, incidentId))
    .for('update');
  if (row === undefined) throw notFound('No such incident');
  return row;
}

const actorUserId = (ctx: DomainContext): string | null =>
  ctx.actor.type === 'user' ? ctx.actor.id : null;

async function assertStaff(tx: DbTransaction, userId: string): Promise<void> {
  const [row] = await tx
    .select({ role: schema.users.role, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (row === undefined || row.status !== 'active' || row.role === 'client') {
    throw badRequest('The commander must be an active member of staff');
  }
}

/** Links alerts to an incident (those already linked to another incident are refused). Returns how many were attached. */
async function attachAlerts(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  incidentId: string,
  alertIds: readonly string[],
): Promise<number> {
  if (alertIds.length === 0) return 0;
  const found = await tx
    .select({ id: schema.alert.id, incidentId: schema.alert.incidentId })
    .from(schema.alert)
    .where(inArray(schema.alert.id, [...alertIds]))
    .for('update');
  if (found.length !== new Set(alertIds).size) throw badRequest('No such alert');
  if (found.some((row) => row.incidentId !== null && row.incidentId !== incidentId)) {
    throw conflict('An alert already belongs to another incident');
  }
  const fresh = found.filter((row) => row.incidentId === null).map((row) => row.id);
  if (fresh.length === 0) return 0;
  await tx
    .update(schema.alert)
    .set({ incidentId, updatedAt: dbNow })
    .where(inArray(schema.alert.id, fresh));
  await addTimelineEntry(tx, ctx, incidentId, 'alert_linked', { alerts: fresh.length });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentLinkAlert,
    targetType: 'incident',
    targetId: incidentId,
    metadata: { alerts: fresh.length },
  });
  return fresh.length;
}

/** Links one ticket; its organization becomes an affected organization (source `ticket`). */
async function attachTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  incidentId: string,
  ticketId: string,
): Promise<boolean> {
  const [ticket] = await tx
    .select({
      id: schema.ticket.id,
      orgId: schema.ticket.orgId,
      incidentId: schema.ticket.incidentId,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .for('update');
  if (ticket === undefined) throw notFound('No such ticket');
  if (ticket.incidentId === incidentId) return false;
  if (ticket.incidentId !== null)
    throw conflict('The ticket is already linked to another incident');
  await tx
    .update(schema.ticket)
    .set({ incidentId, updatedAt: dbNow })
    .where(and(eq(schema.ticket.id, ticketId), isNull(schema.ticket.incidentId)));
  await tx
    .insert(schema.incidentOrg)
    .values({ incidentId, orgId: ticket.orgId, source: 'ticket' })
    .onConflictDoNothing();
  await recordTicketEvent(
    tx,
    ticketId,
    INCIDENTS_TICKET_EVENTS.incidentLinked,
    ctx.actor,
    'internal',
    {
      incidentId,
    },
  );
  await addTimelineEntry(tx, ctx, incidentId, 'ticket_linked', { ticketId });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentLinkTicket,
    targetType: 'incident',
    targetId: incidentId,
    metadata: { ticketId },
  });
  return true;
}

/**
 * Opens an incident (R-3.12): severity, affected services, and optionally the alerts and tickets that
 * prompted it. Always a person's decision (PRD section 5.3: the system proposes, a person decides), so
 * only a user can create one. The Discord thread is queued through the outbox. Returns its id and key.
 */
export async function createIncident(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateIncident,
): Promise<DomainResult<IncidentRef>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  if (userId === null) throw badRequest('Only a person can open an incident');
  const parsed = createIncidentSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The incident is not valid');
  const body = parsed.data;
  if (body.commanderId !== undefined && body.commanderId !== null) {
    await assertStaff(tx, body.commanderId);
  }

  const serviceIds = [...new Set(body.serviceIds)];
  if (serviceIds.length > 0) {
    const known = await tx
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(inArray(schema.service.id, serviceIds));
    if (known.length !== serviceIds.length) throw badRequest('No such service');
  }
  const orgIds = [...new Set(body.orgIds)];
  if (orgIds.length > 0) {
    const known = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(inArray(schema.organization.id, orgIds));
    if (known.length !== orgIds.length) throw badRequest('No such organization');
  }

  const [created] = await tx
    .insert(schema.incident)
    .values({
      title: body.title,
      severity: body.severity,
      commanderId: body.commanderId ?? userId,
      createdBy: userId,
    })
    .returning({ id: schema.incident.id, number: schema.incident.number });
  if (created === undefined) throw new Error('incident insert returned no row');
  const incidentId = created.id;
  const key = formatIncidentKey(created.number);

  if (serviceIds.length > 0) {
    await tx
      .insert(schema.incidentService)
      .values(serviceIds.map((serviceId) => ({ incidentId, serviceId })));
  }
  if (orgIds.length > 0) {
    await tx
      .insert(schema.incidentOrg)
      .values(orgIds.map((orgId) => ({ incidentId, orgId, source: 'manual' })));
  }
  await addTimelineEntry(tx, ctx, incidentId, 'created', {
    severity: body.severity,
    services: serviceIds.length,
  });
  await attachAlerts(tx, ctx, fx, incidentId, body.alertIds);
  for (const ticketId of new Set(body.ticketIds)) {
    await attachTicket(tx, ctx, fx, incidentId, ticketId);
  }
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.incidents,
    name: INCIDENTS_JOBS.thread,
    jobId: `incident-thread-${incidentId}`,
    payload: { incidentId },
    options: INCIDENTS_OUTBOX_JOB_OPTIONS,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentCreate,
    targetType: 'incident',
    targetId: incidentId,
    metadata: { key, severity: body.severity, services: serviceIds.length },
  });
  return fx.result({ incidentId, key });
}

export interface UpdateIncidentInput extends UpdateIncident {
  readonly incidentId: string;
}

/**
 * Changes an incident: title, severity, status, commander, root cause. Each change that matters is a
 * timeline entry; `resolved` stamps `resolved_at` with the database clock and is final. A status
 * change to `resolved` needs the caller to hold `incident.manage`: the API checks that before calling,
 * and passes `canResolve` so a domain caller (the Discord command) cannot forget it.
 */
export async function updateIncident(
  tx: DbTransaction,
  ctx: DomainContext,
  input: UpdateIncidentInput & { readonly canResolve: boolean },
): Promise<DomainResult<IncidentRef>> {
  const fx = new Effects();
  if (actorUserId(ctx) === null) throw badRequest('Only a person can change an incident');
  const { incidentId, canResolve, ...rest } = input;
  const parsed = updateIncidentSchema.safeParse(rest);
  if (!parsed.success) throw badRequest('The change is not valid');
  const change = parsed.data;
  const current = await lockIncident(tx, incidentId);
  const key = formatIncidentKey(current.number);
  if (current.status === 'resolved') throw conflict('A resolved incident cannot be changed');

  if (change.commanderId !== undefined && change.commanderId !== null) {
    await assertStaff(tx, change.commanderId);
  }
  if (change.status !== undefined) {
    if (!incidentStatusAllows(current.status as IncidentStatus, change.status)) {
      throw invalidTransition(`An incident cannot go from ${current.status} to ${change.status}`);
    }
    if (change.status === 'resolved' && !canResolve) {
      throw badRequest('Resolving an incident needs permission to close incidents');
    }
  }
  await tx
    .update(schema.incident)
    .set({
      updatedAt: dbNow,
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.rootCause === undefined ? {} : { rootCause: change.rootCause }),
      ...(change.commanderId === undefined ? {} : { commanderId: change.commanderId }),
      ...(change.severity === undefined ? {} : { severity: change.severity }),
      ...(change.status === undefined ? {} : { status: change.status }),
      // The time of a resolution is the database clock.
      ...(change.status === 'resolved' ? { resolvedAt: dbNow } : {}),
    })
    .where(eq(schema.incident.id, incidentId));

  if (change.status !== undefined) {
    await addTimelineEntry(tx, ctx, incidentId, 'status_changed', {
      from: current.status,
      to: change.status,
    });
  }
  if (change.severity !== undefined && change.severity !== current.severity) {
    await addTimelineEntry(tx, ctx, incidentId, 'severity_changed', {
      from: current.severity,
      to: change.severity,
    });
  }
  if (change.commanderId !== undefined && change.commanderId !== current.commanderId) {
    await addTimelineEntry(tx, ctx, incidentId, 'commander_changed', {
      commanderId: change.commanderId,
    });
  }
  await recordAuditInTx(tx, ctx, fx, {
    action:
      change.status === 'resolved'
        ? INCIDENTS_AUDIT_ACTIONS.incidentResolve
        : INCIDENTS_AUDIT_ACTIONS.incidentUpdate,
    targetType: 'incident',
    targetId: incidentId,
    metadata: { key, fields: Object.keys(change).toSorted() },
  });
  return fx.result({ incidentId, key });
}

/** Links a ticket to an incident (R-3.12). `changed: false` when it already was. */
export async function linkIncidentTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly incidentId: string; readonly ticketId: string },
): Promise<DomainResult<{ readonly changed: boolean }>> {
  const fx = new Effects();
  if (actorUserId(ctx) === null) throw badRequest('Only a person can link a ticket');
  const current = await lockIncident(tx, input.incidentId);
  if (current.status === 'resolved') throw conflict('A resolved incident cannot take new tickets');
  const changed = await attachTicket(tx, ctx, fx, input.incidentId, input.ticketId);
  return fx.result({ changed });
}

/** Unlinks a ticket. The affected organization it brought stays until someone removes it. */
export async function unlinkIncidentTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly incidentId: string; readonly ticketId: string },
): Promise<DomainResult<{ readonly changed: boolean }>> {
  const fx = new Effects();
  if (actorUserId(ctx) === null) throw badRequest('Only a person can unlink a ticket');
  await lockIncident(tx, input.incidentId);
  const updated = await tx
    .update(schema.ticket)
    .set({ incidentId: null, updatedAt: dbNow })
    .where(
      and(eq(schema.ticket.id, input.ticketId), eq(schema.ticket.incidentId, input.incidentId)),
    )
    .returning({ id: schema.ticket.id });
  if (updated.length === 0) return fx.result({ changed: false });
  await recordTicketEvent(
    tx,
    input.ticketId,
    INCIDENTS_TICKET_EVENTS.incidentUnlinked,
    ctx.actor,
    'internal',
    {
      incidentId: input.incidentId,
    },
  );
  await addTimelineEntry(tx, ctx, input.incidentId, 'ticket_unlinked', {
    ticketId: input.ticketId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentUnlinkTicket,
    targetType: 'incident',
    targetId: input.incidentId,
    metadata: { ticketId: input.ticketId },
  });
  return fx.result({ changed: true });
}

/** Links one alert to an incident. `changed: false` when it already was. */
export async function linkIncidentAlert(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly incidentId: string; readonly alertId: string },
): Promise<DomainResult<{ readonly changed: boolean }>> {
  const fx = new Effects();
  if (actorUserId(ctx) === null) throw badRequest('Only a person can link an alert');
  const current = await lockIncident(tx, input.incidentId);
  if (current.status === 'resolved') throw conflict('A resolved incident cannot take new alerts');
  const attached = await attachAlerts(tx, ctx, fx, input.incidentId, [input.alertId]);
  return fx.result({ changed: attached > 0 });
}

/** A free-text note on the timeline (internal; never mirrored to chat). */
export async function addIncidentNote(
  tx: DbTransaction,
  ctx: DomainContext,
  input: {
    readonly incidentId: string;
    readonly text: string;
    /** References to staff uploads, kept in the timeline payload (`[{id, filename, contentType, size}]`). */
    readonly attachments?: readonly Record<string, unknown>[];
  },
): Promise<DomainResult<{ readonly timelineId: string }>> {
  const fx = new Effects();
  if (actorUserId(ctx) === null) throw badRequest('Only a person can add a note');
  const parsed = incidentNoteSchema.safeParse({ text: input.text });
  if (!parsed.success) throw badRequest('The note is not valid');
  const current = await lockIncident(tx, input.incidentId);
  if (current.status === 'resolved') throw conflict('A resolved incident cannot take new notes');
  const attachments = input.attachments ?? [];
  const timelineId = await addTimelineEntry(tx, ctx, input.incidentId, 'note', {
    text: parsed.data.text,
    ...(attachments.length === 0 ? {} : { attachments }),
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.incidentNote,
    targetType: 'incident',
    targetId: input.incidentId,
    metadata: { length: parsed.data.text.length, attachments: attachments.length },
  });
  return fx.result({ timelineId });
}
