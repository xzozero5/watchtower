import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import { ticketRefCondition } from '@watchtower/domain';
import {
  type AiState,
  type TicketAiRow,
  CLIENT_HIDDEN_DELIVERY_STATUSES,
  DUPLICATE_SUGGESTION_LIMIT,
  DUPLICATE_WINDOW_HOURS,
  OPEN_STATUSES,
  type ChannelType,
  type ClientTicket,
  type DuplicateSuggestions,
  type SimilarTickets,
  type SimilarTicketsQuery,
  SIMILAR_TICKET_LIMIT,
  SIMILAR_TICKET_THRESHOLD,
  TICKET_REFERENCE_LINK_KINDS,
  type TicketDetail,
  type TicketReference,
  type TicketListQuery,
  type TicketPriority,
  type TicketSlaView,
  type TicketStats,
  type TicketStatsQuery,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  gte,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import { badRequest, forbidden, notFound } from '../auth/http-errors.js';
import { assertOrgAccess, type Principal } from '../auth/principal.js';
import {
  afterCursor,
  beforeCursor,
  decodeCursor,
  likeContains,
  preciseTimestamp,
  toPage,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { translatingSync } from '../domain/domain-errors.js';
import { createMaskingSession, type MaskingSession } from '../masking/pii-masker.js';
import { SlaRemaining } from './sla-remaining.js';
import { TicketSlaStates, runningDueSortKey } from './sla-states.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';

export type TicketRow = typeof schema.ticket.$inferSelect;

/** At most this many contact names are given to the redactor for one ticket. */
const MASKING_NAME_LIMIT = 300;
type Executor = Pick<Database['db'], 'select'>;

/** A ticket with the names its views show, loaded in one query. */
export interface TicketViewRow {
  readonly t: TicketRow;
  readonly orgName: string;
  readonly requesterName: string | null;
  readonly requesterEmail: string | null;
  readonly intentKey: string | null;
  readonly intentName: string | null;
  readonly assigneeName: string | null;
  readonly devOwnerName: string | null;
  readonly queueName: string | null;
  readonly parentNumber: number | null;
  /** The latest AI result for the ticket (T-106d), null when there is none. */
  readonly aiState: string | null;
  readonly aiSummary: string | null;
}

const parent = alias(schema.ticket, 'parent_ticket');
const devOwner = alias(schema.users, 'dev_owner');

function selection() {
  return {
    t: schema.ticket,
    orgName: schema.organization.name,
    requesterName: schema.contact.name,
    requesterEmail: sql<string | null>`${schema.contact.emails}[1]`,
    intentKey: schema.intent.key,
    intentName: schema.intent.name,
    assigneeName: schema.users.name,
    devOwnerName: devOwner.name,
    queueName: schema.teamQueue.name,
    parentNumber: parent.number,
    aiState: schema.aiTicketInsight.state,
    aiSummary: schema.aiTicketInsight.summary,
  };
}

function viewQuery<Extra extends Record<string, SQL>>(executor: Executor, extra: Extra) {
  return (
    executor
      .select({ ...selection(), ...extra })
      .from(schema.ticket)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.ticket.orgId))
      .leftJoin(schema.contact, eq(schema.contact.id, schema.ticket.requesterContactId))
      .leftJoin(schema.intent, eq(schema.intent.id, schema.ticket.intentId))
      .leftJoin(schema.users, eq(schema.users.id, schema.ticket.assigneeId))
      .leftJoin(devOwner, eq(devOwner.id, schema.ticket.devOwnerId))
      .leftJoin(schema.teamQueue, eq(schema.teamQueue.id, schema.ticket.queueId))
      .leftJoin(parent, eq(parent.id, schema.ticket.parentTicketId))
      // One row per ticket (the primary key), so this join never multiplies rows.
      .leftJoin(schema.aiTicketInsight, eq(schema.aiTicketInsight.ticketId, schema.ticket.id))
  );
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toSummary(
  row: TicketViewRow,
  keys: TicketKeys,
  sla: TicketSlaView | null = null,
): TicketSummary {
  const t = row.t;
  return {
    id: t.id,
    number: t.number,
    key: keys.format(t.number),
    subject: t.subject,
    status: t.status as TicketStatus,
    priority: t.priority as TicketPriority,
    channel: t.channel as ChannelType,
    org: { id: t.orgId, name: row.orgName },
    requester:
      t.requesterContactId && row.requesterName !== null
        ? { id: t.requesterContactId, name: row.requesterName }
        : null,
    intent:
      t.intentId && row.intentKey !== null && row.intentName !== null
        ? { id: t.intentId, key: row.intentKey, name: row.intentName }
        : null,
    assignee:
      t.assigneeId && row.assigneeName !== null
        ? { id: t.assigneeId, name: row.assigneeName }
        : null,
    devOwner:
      t.devOwnerId && row.devOwnerName !== null
        ? { id: t.devOwnerId, name: row.devOwnerName }
        : null,
    queue: t.queueId && row.queueName !== null ? { id: t.queueId, name: row.queueName } : null,
    slaPolicyId: t.slaPolicyId,
    firstResponseDueAt: iso(t.firstResponseDueAt),
    resolutionDueAt: iso(t.resolutionDueAt),
    slaPausedAt: iso(t.slaPausedAt),
    firstRespondedAt: iso(t.firstRespondedAt),
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    parentTicketId: t.parentTicketId,
    mergedIntoKey: row.parentNumber === null ? null : keys.format(row.parentNumber),
    tags: t.tags,
    customFields: (t.customFields ?? {}) as Record<string, unknown>,
    autonomyStageAtCreation: t.autonomyStageAtCreation,
    aiHandled: t.aiHandled,
    reopenCount: t.reopenCount,
    csatScore: t.csatScore,
    // Staff only: `toClientTicket` has no AI field (AI internals are never shown to customers).
    ai: toAiRow(row),
    // Absent when no SLA target runs; the time left is counted by the server on the policy's calendar.
    ...(sla === null ? {} : { sla }),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** `none` when the AI has not made a brief for the ticket (yet); never invented content (N5). */
function toAiRow(row: TicketViewRow): TicketAiRow {
  if (row.aiState === null) return { state: 'none' };
  return {
    state: row.aiState as AiState,
    ...(row.aiSummary === null ? {} : { summary: row.aiSummary.slice(0, 200) }),
  };
}

/** The only shape a client ever gets: no assignee, queue, SLA, tags, custom fields or AI flags. */
export function toClientTicket(row: TicketViewRow, keys: TicketKeys): ClientTicket {
  const t = row.t;
  return {
    id: t.id,
    number: t.number,
    key: keys.format(t.number),
    subject: t.subject,
    status: t.status as TicketStatus,
    priority: t.priority as TicketPriority,
    intent: t.intentId && row.intentName !== null ? { id: t.intentId, name: row.intentName } : null,
    requesterName: row.requesterName,
    mergedIntoKey: row.parentNumber === null ? null : keys.format(row.parentNumber),
    resolvedAt: iso(t.resolvedAt),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * `uuid` or `OPS-1234` (with this instance's prefix) as a WHERE condition on the ticket table. Text
 * that is neither is "no such ticket", never a query: a uuid column would reject it with an error.
 */
export function refCondition(ref: string, keys: TicketKeys): SQL {
  return translatingSync(() => ticketRefCondition(ref, keys));
}

/**
 * A client never sees a ticket the system opened for its own people: channel `internal` (a usage anomaly,
 * T-205c). Staff see them like any other ticket.
 */
function hiddenFromClient(principal: Principal): SQL | undefined {
  return principal.orgScope.kind === 'org' ? ne(schema.ticket.channel, 'internal') : undefined;
}

/**
 * A caller who reads tickets with personal data masked: `ticket.read.masked` without `ticket.read` (the
 * `dev` role, T-137). Holding both means the full read, so a head who widens the role on purpose widens
 * it; having neither is not a reader at all.
 */
export function isMasked(principal: Principal): boolean {
  return (
    principal.orgScope.kind === 'all' &&
    principal.permissions.has('ticket.read.masked') &&
    !principal.permissions.has('ticket.read')
  );
}

/**
 * Staff need `ticket.read`; a client needs `ticket.read.org`; a developer needs `ticket.read.masked`.
 * Having only another one is not enough.
 */
export function assertCanRead(principal: Principal): void {
  if (principal.orgScope.kind === 'org') {
    if (!principal.permissions.has('ticket.read.org')) throw forbidden();
    return;
  }
  if (!principal.permissions.has('ticket.read') && !isMasked(principal)) throw forbidden();
}

/**
 * A summary as a masked reader gets it: the subject and tags through the redactor, the requester's name
 * reduced to initials, custom fields left out (free-form JSON that can hold anything), the AI one-liner
 * redacted. Nothing is copied from the original except structure, ids, numbers and dates.
 */
export function maskSummary(summary: TicketSummary, session: MaskingSession): TicketSummary {
  return {
    ...summary,
    subject: session.text(summary.subject),
    requester:
      summary.requester === null
        ? null
        : { id: summary.requester.id, name: session.name(summary.requester.name) ?? '***' },
    tags: summary.tags.map((tag) => session.text(tag)),
    customFields: {},
    ...(summary.ai?.summary === undefined
      ? {}
      : { ai: { ...summary.ai, summary: session.text(summary.ai.summary) } }),
  };
}

export function isClient(principal: Principal): boolean {
  return principal.orgScope.kind === 'org';
}

/** Reads tickets for the API: lists with filters and search, and the detail of one. */
@Injectable()
export class TicketReader {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(TicketSlaStates) private readonly slaStates: TicketSlaStates,
    @Inject(SlaRemaining) private readonly slaRemaining: SlaRemaining,
  ) {}

  /** One ticket the principal may see, as a row with names; 404 if it does not exist or is not theirs. */
  async viewRow(
    ref: string,
    principal: Principal,
    executor: Executor = this.database.db,
  ): Promise<TicketViewRow> {
    assertCanRead(principal);
    const [row] = await viewQuery(executor, {})
      .where(
        and(
          refCondition(ref, this.keys),
          orgScopeCondition(schema.ticket.orgId, principal.orgScope),
          hiddenFromClient(principal),
        ),
      )
      .limit(1);
    if (!row) throw notFound('No such ticket');
    // Belt and braces: the query already filtered by organization.
    assertOrgAccess(principal, row.t.orgId);
    return row;
  }

  /** The same, by uuid, for code that just wrote the ticket and wants to return its view. */
  async viewById(
    id: string,
    principal: Principal,
    executor: Executor = this.database.db,
  ): Promise<TicketViewRow> {
    return this.viewRow(id, principal, executor);
  }

  async detail(
    ref: string,
    principal: Principal,
    executor: Executor = this.database.db,
  ): Promise<TicketDetail | ClientTicket> {
    return this.present(await this.viewRow(ref, principal, executor), principal, executor);
  }

  /** The view of a loaded row for this principal: staff get the full detail, a client the safe subset. */
  async present(
    row: TicketViewRow,
    principal: Principal,
    executor: Executor = this.database.db,
  ): Promise<TicketDetail | ClientTicket> {
    if (isClient(principal)) return toClientTicket(row, this.keys);
    if (isMasked(principal)) return this.maskedDetail(row, executor);
    return this.staffDetail(row, executor);
  }

  /** The detail a developer gets: the same shape, personal data masked (T-137). */
  async maskedDetail(
    row: TicketViewRow,
    executor: Executor = this.database.db,
  ): Promise<TicketDetail> {
    const detail = await this.staffDetail(row, executor);
    const session = createMaskingSession(row.t.id, await this.namesAround(row, executor));
    const summary = maskSummary(detail, session);
    return {
      ...detail,
      ...summary,
      requester:
        detail.requester === null
          ? null
          : {
              id: detail.requester.id,
              name: session.name(detail.requester.name) ?? '***',
              email: session.email(detail.requester.email),
            },
      mergedTickets: detail.mergedTickets.map((child) => ({
        ...child,
        subject: session.text(child.subject),
      })),
      references: (detail.references ?? []).map((link) => ({
        ...link,
        label: session.text(link.label),
      })),
      masked: true,
    };
  }

  /**
   * The names the redactor must know for this ticket: the requester and the other contacts of the
   * organization (a message often names a colleague). A scoped list, as the redactor asks.
   */
  async namesAround(row: TicketViewRow, executor: Executor = this.database.db): Promise<string[]> {
    const contacts = await executor
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(eq(schema.contact.orgId, row.t.orgId))
      .limit(MASKING_NAME_LIMIT);
    return [
      ...new Set([
        ...(row.requesterName === null ? [] : [row.requesterName]),
        ...contacts.map((c) => c.name),
      ]),
    ];
  }

  /** Incidents and deploys a ticket is linked to, oldest first. */
  async references(
    ticketId: string,
    executor: Executor = this.database.db,
  ): Promise<TicketReference[]> {
    const rows = await executor
      .select({
        id: schema.ticketLink.id,
        kind: schema.ticketLink.kind,
        createdAt: schema.ticketLink.createdAt,
        incidentId: schema.ticketLink.incidentId,
        incidentNumber: schema.incident.number,
        incidentTitle: schema.incident.title,
        deployId: schema.ticketLink.deployId,
        serviceSlug: schema.deploy.serviceSlug,
        version: schema.deploy.version,
        env: schema.deploy.env,
      })
      .from(schema.ticketLink)
      .leftJoin(schema.incident, eq(schema.incident.id, schema.ticketLink.incidentId))
      .leftJoin(schema.deploy, eq(schema.deploy.id, schema.ticketLink.deployId))
      .where(
        and(
          eq(schema.ticketLink.fromTicketId, ticketId),
          inArray(schema.ticketLink.kind, [...TICKET_REFERENCE_LINK_KINDS]),
        ),
      )
      .orderBy(asc(schema.ticketLink.createdAt), asc(schema.ticketLink.id));
    return rows.flatMap((row): TicketReference[] => {
      if (row.kind === 'incident' && row.incidentId !== null) {
        return [
          {
            id: row.id,
            kind: 'incident',
            targetId: row.incidentId,
            label: `INC-${String(row.incidentNumber ?? '')} ${row.incidentTitle ?? ''}`.trim(),
            createdAt: row.createdAt.toISOString(),
          },
        ];
      }
      if (row.kind === 'deploy' && row.deployId !== null) {
        return [
          {
            id: row.id,
            kind: 'deploy',
            targetId: row.deployId,
            label: `${row.serviceSlug ?? ''} ${row.version ?? ''} (${row.env ?? ''})`.trim(),
            createdAt: row.createdAt.toISOString(),
          },
        ];
      }
      return [];
    });
  }

  async staffDetail(
    row: TicketViewRow,
    executor: Executor = this.database.db,
  ): Promise<TicketDetail> {
    const references = await this.references(row.t.id, executor);
    const children = await executor
      .select({
        id: schema.ticket.id,
        number: schema.ticket.number,
        subject: schema.ticket.subject,
      })
      .from(schema.ticket)
      .where(eq(schema.ticket.parentTicketId, row.t.id))
      .orderBy(asc(schema.ticket.number));
    return {
      ...toSummary(row, this.keys, await this.slaRemaining.view(row.t, new Date())),
      requester:
        row.t.requesterContactId && row.requesterName !== null
          ? { id: row.t.requesterContactId, name: row.requesterName, email: row.requesterEmail }
          : null,
      mergedTickets: children.map((child) => ({
        id: child.id,
        key: this.keys.format(child.number),
        subject: child.subject,
      })),
      references,
    };
  }

  /**
   * Tickets this one may duplicate (R-1.5): same organization, same intent, filed in the last
   * `DUPLICATE_WINDOW_HOURS`, not merged or closed, and not the ticket itself. Seen exactly as the
   * ticket is: a ticket the principal cannot read is a 404, and a client gets the client shape.
   */
  async duplicates(
    ref: string,
    principal: Principal,
  ): Promise<DuplicateSuggestions & { ticketId: string }> {
    const source = await this.viewRow(ref, principal);
    const { ticket } = schema;
    if (source.t.intentId === null) return { ticketId: source.t.id, items: [] };
    const rows = await viewQuery(this.database.db, {})
      .where(
        and(
          orgScopeCondition(ticket.orgId, principal.orgScope),
          hiddenFromClient(principal),
          eq(ticket.orgId, source.t.orgId),
          eq(ticket.intentId, source.t.intentId),
          ne(ticket.id, source.t.id),
          notInArray(ticket.status, ['merged', 'closed']),
          gte(ticket.createdAt, sql`now() - make_interval(hours => ${DUPLICATE_WINDOW_HOURS})`),
        ),
      )
      .orderBy(desc(ticket.createdAt), desc(ticket.id))
      .limit(DUPLICATE_SUGGESTION_LIMIT);
    const client = isClient(principal);
    const slas = client
      ? []
      : await this.slaRemaining.viewMany(
          rows.map((row) => row.t),
          new Date(),
        );
    const session = isMasked(principal) ? this.pageSession(rows) : null;
    return {
      ticketId: source.t.id,
      items: rows.map((row, index) => {
        if (client) return toClientTicket(row, this.keys);
        const summary = toSummary(row, this.keys, slas[index] ?? null);
        return session === null ? summary : maskSummary(summary, session);
      }),
    };
  }

  /**
   * Open tickets of the organization that may be the same request as the one being typed (T-136): same
   * requester and a similar subject, or a very similar subject. Staff only (the subjects are shown in
   * full); a masked reader and a client do not file tickets by hand.
   */
  async similar(query: SimilarTicketsQuery, principal: Principal): Promise<SimilarTickets> {
    assertCanRead(principal);
    if (isClient(principal) || isMasked(principal)) throw forbidden();
    const { ticket } = schema;
    const similarity = sql<number>`similarity(lower(${ticket.subject}), lower(${query.subject}))`;
    const sameRequester =
      query.requesterContactId === undefined
        ? sql<boolean>`false`
        : sql<boolean>`${ticket.requesterContactId} = ${query.requesterContactId}`;
    const rows = await this.database.db
      .select({
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt,
        similarity: similarity.as('similarity'),
        sameRequester: sameRequester.as('same_requester'),
      })
      .from(ticket)
      .where(
        and(
          eq(ticket.orgId, query.orgId),
          inArray(ticket.status, [...OPEN_STATUSES]),
          sql`${similarity} >= ${SIMILAR_TICKET_THRESHOLD}`,
        ),
      )
      // By the output names: a parameter inside ORDER BY would be read as a column number.
      .orderBy(sql`same_requester desc`, sql`similarity desc`, desc(ticket.createdAt))
      .limit(SIMILAR_TICKET_LIMIT);
    return {
      items: rows.map((row) => ({
        id: row.id,
        key: this.keys.format(row.number),
        subject: row.subject,
        status: row.status as TicketStatus,
        priority: row.priority as TicketPriority,
        createdAt: row.createdAt.toISOString(),
        sameRequester: row.sameRequester,
        similarity: Math.min(1, Math.max(0, row.similarity)),
      })),
    };
  }

  /** One masking session for a page of tickets; it knows the requesters' names on the page. */
  private pageSession(rows: readonly TicketViewRow[]): MaskingSession {
    const names = rows.flatMap((row) => (row.requesterName === null ? [] : [row.requesterName]));
    return createMaskingSession('page', [...new Set(names)]);
  }

  /**
   * The WHERE conditions both the list and the counts apply: the caller's organization first (a
   * client is never given anything else), then the filters of the query. The SLA state filter is
   * not here because it needs a query of its own (`slaStates`).
   */
  private filterConditions(
    query: Omit<TicketStatsQuery, 'slaState'>,
    principal: Principal,
  ): (SQL | undefined)[] {
    const client = isClient(principal);
    const { ticket, message } = schema;
    const masked = isMasked(principal);

    const conditions: (SQL | undefined)[] = [
      // Every query a client runs is limited to their organization, whatever else they ask for.
      orgScopeCondition(ticket.orgId, principal.orgScope),
      hiddenFromClient(principal),
      client ? undefined : query.orgId === undefined ? undefined : eq(ticket.orgId, query.orgId),
      query.status === undefined ? undefined : inArray(ticket.status, query.status),
      query.priority === undefined ? undefined : inArray(ticket.priority, query.priority),
      query.intentId === undefined ? undefined : eq(ticket.intentId, query.intentId),
    ];
    if (!client) {
      if (query.devOwner === 'unassigned') conditions.push(isNull(ticket.devOwnerId));
      else if (query.devOwner === 'me') conditions.push(eq(ticket.devOwnerId, principal.userId));
      else if (query.devOwner !== undefined) conditions.push(eq(ticket.devOwnerId, query.devOwner));
      if (query.assignee === 'unassigned') conditions.push(isNull(ticket.assigneeId));
      else if (query.assignee === 'me') conditions.push(eq(ticket.assigneeId, principal.userId));
      else if (query.assignee !== undefined) conditions.push(eq(ticket.assigneeId, query.assignee));
      if (query.queueId !== undefined) conditions.push(eq(ticket.queueId, query.queueId));
      if (query.channel !== undefined) conditions.push(eq(ticket.channel, query.channel));
      if (query.tag !== undefined) {
        // A tag is free text a person typed, so it is masked on the way out and cannot be searched on
        // the way in either (same oracle as the text search).
        if (masked) throw badRequest('Filtering by tag needs full access');
        conditions.push(arrayContains(ticket.tags, [query.tag]));
      }
      if (query.overdue === true) {
        conditions.push(
          inArray(ticket.status, [...OPEN_STATUSES]),
          isNull(ticket.slaPausedAt),
          or(
            and(isNull(ticket.firstRespondedAt), lt(ticket.firstResponseDueAt, sql`now()`)),
            lt(ticket.resolutionDueAt, sql`now()`),
          ),
        );
      }
    }

    if (query.q !== undefined) {
      const ticketNumber = this.keys.parse(query.q);
      // Searching the text would let a masked reader find out who wrote what by trying addresses and
      // numbers (an oracle on the very data that is hidden). They find a ticket by its number.
      if (masked && ticketNumber === null) {
        throw badRequest(
          'Search by ticket number (for example OPS-1234); text search needs full access',
        );
      }
      const pattern = likeContains(query.q);
      conditions.push(
        masked
          ? eq(ticket.number, ticketNumber ?? -1)
          : or(
              ticketNumber === null ? undefined : eq(ticket.number, ticketNumber),
              ilike(ticket.subject, pattern),
              // The text of messages is searched too, but a client's search never reaches an internal note.
              exists(
                this.database.db
                  .select({ one: sql`1` })
                  .from(message)
                  .where(
                    and(
                      eq(message.ticketId, ticket.id),
                      ilike(message.bodyText, pattern),
                      client ? eq(message.visibility, 'public') : undefined,
                      client
                        ? notInArray(message.deliveryStatus, [...CLIENT_HIDDEN_DELIVERY_STATUSES])
                        : undefined,
                    ),
                  ),
              ),
            ),
      );
    }
    return conditions;
  }

  /**
   * Ticket counts by status, queue, assignee and priority with their SLA states (T-127). Staff
   * only: a client has no queue, assignee or SLA to count. Takes the filters of the list.
   */
  async stats(query: TicketStatsQuery, principal: Principal): Promise<TicketStats> {
    assertCanRead(principal);
    if (isClient(principal)) throw forbidden('Ticket statistics are for staff');
    const now = new Date();
    const conditions = this.filterConditions(query, principal);
    if (query.slaState !== undefined) {
      conditions.push(await this.slaStates.condition(query.slaState, conditions, now));
    }
    return this.slaStates.stats(conditions, now);
  }

  /**
   * How many tickets the filters match, for the number beside a saved view. Staff only. One query,
   * unlike `stats` which also groups by status, queue, assignee and priority.
   */
  async count(query: TicketStatsQuery, principal: Principal): Promise<number> {
    assertCanRead(principal);
    if (isClient(principal)) throw forbidden('Ticket counts are for staff');
    const conditions = this.filterConditions(query, principal);
    if (query.slaState !== undefined) {
      conditions.push(await this.slaStates.condition(query.slaState, conditions, new Date()));
    }
    const [row] = await this.database.db
      .select({ n: count() })
      .from(schema.ticket)
      .where(and(...conditions));
    return row?.n ?? 0;
  }

  async list(
    query: TicketListQuery,
    principal: Principal,
  ): Promise<{ items: (TicketSummary | ClientTicket)[]; nextCursor: string | null }> {
    assertCanRead(principal);
    const client = isClient(principal);
    const { ticket } = schema;
    const conditions = this.filterConditions(query, principal);
    if (!client && query.slaState !== undefined) {
      conditions.push(await this.slaStates.condition(query.slaState, conditions, new Date()));
    }

    // The due-based sorts put tickets without a due date last (their key is infinity). A client has
    // no SLA, so a due sort means newest first for them.
    const sort =
      client && (query.sort === 'due_asc' || query.sort === 'sla_due_asc')
        ? 'created_desc'
        : query.sort;
    const key: PgColumn | SQL = {
      created_desc: ticket.createdAt,
      created_asc: ticket.createdAt,
      updated_desc: ticket.updatedAt,
      due_asc: sql`coalesce(${ticket.firstResponseDueAt}, 'infinity'::timestamptz)`,
      sla_due_asc: runningDueSortKey(),
    }[sort];
    const ascending = sort === 'due_asc' || sort === 'sla_due_asc' || sort === 'created_asc';
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      conditions.push(
        ascending ? afterCursor(key, ticket.id, cursor) : beforeCursor(key, ticket.id, cursor),
      );
    }

    const rows = await viewQuery(this.database.db, { sortKey: preciseTimestamp(key) })
      .$dynamic()
      .where(and(...conditions))
      .orderBy(...(ascending ? [asc(key), asc(ticket.id)] : [desc(key), desc(ticket.id)]))
      .limit(query.limit + 1);

    const page = toPage(
      rows.map((row) => ({ row, id: row.t.id, sortKey: row.sortKey })),
      query.limit,
    );
    const slas = client
      ? []
      : await this.slaRemaining.viewMany(
          page.rows.map((entry) => entry.row.t),
          new Date(),
        );
    const session = isMasked(principal) ? this.pageSession(page.rows.map((e) => e.row)) : null;
    return {
      items: page.rows.map((entry, index) => {
        if (client) return toClientTicket(entry.row, this.keys);
        const summary = toSummary(entry.row, this.keys, slas[index] ?? null);
        return session === null ? summary : maskSummary(summary, session);
      }),
      nextCursor: page.nextCursor,
    };
  }
}
