import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import {
  formatIncidentKey,
  type CreateIncident,
  type Deploy,
  type DeployListQuery,
  type Incident,
  type IncidentDetail,
  type IncidentListQuery,
  type IncidentNote,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentTimelineEntry,
  type UpdateIncident,
} from '@watchtower/shared';
import { and, asc, count, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';

import { notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

type IncidentRow = typeof schema.incident.$inferSelect;

/** The bulk facts of a page of incidents, fetched with four queries rather than four per incident. */
async function summarize(db: Database['db'], rows: readonly IncidentRow[]): Promise<Incident[]> {
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
 * Incidents for staff (R-3.12): reads, and the writes that go through `@watchtower/domain`. The rules
 * (a person opens an incident, the status moves forward and ends at `resolved`, a ticket belongs to
 * one incident) live in the domain; this builds the context and answers its refusals with HTTP errors.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
  ) {}

  async list(query: IncidentListQuery) {
    const incident = schema.incident;
    const conditions: (SQL | undefined)[] = [
      query.status === undefined ? undefined : eq(incident.status, query.status),
      query.open === true ? ne(incident.status, 'resolved') : undefined,
      query.cursor === undefined
        ? undefined
        : beforeCursor(incident.createdAt, incident.id, decodeCursor(query.cursor)),
    ];
    const rows = await this.database.db
      .select({ incident, sortKey: preciseTimestamp(incident.createdAt) })
      .from(incident)
      .where(and(...conditions))
      .orderBy(desc(incident.createdAt), desc(incident.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((row) => ({ ...row, id: row.incident.id })),
      query.limit,
    );
    return {
      items: await summarize(
        this.database.db,
        page.rows.map((row) => row.incident),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async getRow(id: string): Promise<IncidentRow> {
    const [row] = await this.database.db
      .select()
      .from(schema.incident)
      .where(eq(schema.incident.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such incident');
    return row;
  }

  async get(id: string): Promise<IncidentDetail> {
    const row = await this.getRow(id);
    const [summary] = await summarize(this.database.db, [row]);
    if (summary === undefined) throw notFound('No such incident');
    const [timeline, tickets, alerts] = await Promise.all([
      this.database.db
        .select()
        .from(schema.incidentTimeline)
        .where(eq(schema.incidentTimeline.incidentId, id))
        .orderBy(asc(schema.incidentTimeline.createdAt), asc(schema.incidentTimeline.id))
        .limit(1000),
      this.database.db
        .select({ id: schema.ticket.id })
        .from(schema.ticket)
        .where(eq(schema.ticket.incidentId, id)),
      this.database.db
        .select({ id: schema.alert.id })
        .from(schema.alert)
        .where(eq(schema.alert.incidentId, id)),
    ]);
    return {
      ...summary,
      ticketIds: tickets.map((entry) => entry.id),
      alertIds: alerts.map((entry) => entry.id),
      timeline: timeline.map((entry): IncidentTimelineEntry => ({
        id: entry.id,
        type: entry.type as IncidentTimelineEntry['type'],
        actorType: entry.actorType as IncidentTimelineEntry['actorType'],
        actorId: entry.actorId,
        payload: entry.payload,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  create(uow: UnitOfWork, actor: Actor, input: CreateIncident): Promise<{ incidentId: string }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.create(uow.tx, domainContext(this.domain, actor), input),
      ),
    );
  }

  update(
    uow: UnitOfWork,
    actor: Actor,
    id: string,
    input: UpdateIncident,
    canResolve: boolean,
  ): Promise<{ incidentId: string }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.update(uow.tx, domainContext(this.domain, actor), {
          ...input,
          incidentId: id,
          canResolve,
        }),
      ),
    );
  }

  linkTicket(uow: UnitOfWork, actor: Actor, incidentId: string, ticketId: string) {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.linkTicket(uow.tx, domainContext(this.domain, actor), {
          incidentId,
          ticketId,
        }),
      ),
    );
  }

  unlinkTicket(uow: UnitOfWork, actor: Actor, incidentId: string, ticketId: string) {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.unlinkTicket(uow.tx, domainContext(this.domain, actor), {
          incidentId,
          ticketId,
        }),
      ),
    );
  }

  linkAlert(uow: UnitOfWork, actor: Actor, incidentId: string, alertId: string) {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.linkAlert(uow.tx, domainContext(this.domain, actor), {
          incidentId,
          alertId,
        }),
      ),
    );
  }

  note(uow: UnitOfWork, actor: Actor, incidentId: string, input: IncidentNote) {
    return translating(async () =>
      settle(
        uow,
        await this.domain.incidents.note(uow.tx, domainContext(this.domain, actor), {
          incidentId,
          text: input.text,
        }),
      ),
    );
  }

  /** Deploys, newest first (R-5.4): what the "what changed" view and a service panel read. */
  async deploys(query: DeployListQuery): Promise<Deploy[]> {
    const rows = await this.database.db
      .select()
      .from(schema.deploy)
      .where(
        query.serviceId === undefined ? undefined : eq(schema.deploy.serviceId, query.serviceId),
      )
      .orderBy(desc(schema.deploy.occurredAt), desc(schema.deploy.id))
      .limit(query.limit);
    return rows.map((row) => ({
      id: row.id,
      serviceId: row.serviceId,
      serviceSlug: row.serviceSlug,
      version: row.version,
      env: row.env,
      actor: row.actor,
      source: row.source as Deploy['source'],
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      url: row.url,
      occurredAt: (row.occurredAt ?? row.receivedAt).toISOString(),
    }));
  }
}
