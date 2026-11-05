import { schema } from '@watchtower/db';
import {
  formatIncidentKey,
  type Incident,
  type IncidentSeverity,
  type IncidentStatus,
} from '@watchtower/shared';
import { count, desc, inArray, ne } from 'drizzle-orm';

import type { ReadExecutor } from '../types.js';

export type IncidentRow = typeof schema.incident.$inferSelect;

/** The bulk facts of a page of incidents, fetched with four queries rather than four per incident. */
export async function summarizeIncidents(
  db: ReadExecutor,
  rows: readonly IncidentRow[],
): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [services, orgs, tickets, alerts] = await Promise.all([
    db.select().from(schema.incidentService).where(inArray(schema.incidentService.incidentId, ids)),
    db.select().from(schema.incidentOrg).where(inArray(schema.incidentOrg.incidentId, ids)),
    db
      .select({ id: schema.ticket.incidentId, n: count() })
      .from(schema.ticket)
      .where(inArray(schema.ticket.incidentId, ids))
      .groupBy(schema.ticket.incidentId),
    db
      .select({ id: schema.alert.incidentId, n: count() })
      .from(schema.alert)
      .where(inArray(schema.alert.incidentId, ids))
      .groupBy(schema.alert.incidentId),
  ]);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    key: formatIncidentKey(row.number),
    title: row.title,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    commanderId: row.commanderId,
    rootCause: row.rootCause,
    discordThreadState: row.discordThreadState as Incident['discordThreadState'],
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    serviceIds: services
      .filter((entry) => entry.incidentId === row.id)
      .map((entry) => entry.serviceId),
    orgIds: orgs.filter((entry) => entry.incidentId === row.id).map((entry) => entry.orgId),
    tickets: tickets.find((entry) => entry.id === row.id)?.n ?? 0,
    alerts: alerts.find((entry) => entry.id === row.id)?.n ?? 0,
  }));
}

/**
 * The incidents that are not resolved, newest first: `GET /v1/incidents?open=true` (first page) and the
 * `incidents.open` insight read it. At most `limit` (the route's largest page is 100).
 */
export async function readOpenIncidents(db: ReadExecutor, limit = 100): Promise<Incident[]> {
  const rows = await db
    .select()
    .from(schema.incident)
    .where(ne(schema.incident.status, 'resolved'))
    .orderBy(desc(schema.incident.createdAt), desc(schema.incident.id))
    .limit(limit);
  return summarizeIncidents(db, rows);
}
