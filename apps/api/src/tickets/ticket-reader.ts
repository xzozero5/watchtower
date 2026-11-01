import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import { ticketRefCondition } from '@watchtower/domain';
import {
  type AiState,
  type TicketAiRow,
  DUPLICATE_SUGGESTION_LIMIT,
  DUPLICATE_WINDOW_HOURS,
  OPEN_STATUSES,
  type ChannelType,
  type ClientTicket,
  type DuplicateSuggestions,
  type TicketDetail,
  type TicketListQuery,
  type TicketPriority,
  type TicketStats,
  type TicketStatsQuery,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import {
  and,
  arrayContains,
  asc,
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

import { forbidden, notFound } from '../auth/http-errors.js';
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
import { TicketSlaStates, runningDueSortKey } from './sla-states.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';

export type TicketRow = typeof schema.ticket.$inferSelect;
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
  readonly queueName: string | null;
  readonly parentNumber: number | null;
  /** The latest AI result for the ticket (T-106d), null when there is none. */
  readonly aiState: string | null;
  readonly aiSummary: string | null;
}

const parent = alias(schema.ticket, 'parent_ticket');

function selection() {
  return {
    t: schema.ticket,
    orgName: schema.organization.name,
    requesterName: schema.contact.name,
    requesterEmail: sql<string | null>`${schema.contact.emails}[1]`,
    intentKey: schema.intent.key,
    intentName: schema.intent.name,
    assigneeName: schema.users.name,
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
      .leftJoin(schema.teamQueue, eq(schema.teamQueue.id, schema.ticket.queueId))
      .leftJoin(parent, eq(parent.id, schema.ticket.parentTicketId))
      // One row per ticket (the primary key), so this join never multiplies rows.
      .leftJoin(schema.aiTicketInsight, eq(schema.aiTicketInsight.ticketId, schema.ticket.id))
  );
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toSummary(row: TicketViewRow, keys: TicketKeys): TicketSummary {
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

/** Staff need `ticket.read`; a client needs `ticket.read.org`. Having only the other one is not enough. */
export function assertCanRead(principal: Principal): void {
  const needed = principal.orgScope.kind === 'org' ? 'ticket.read.org' : 'ticket.read';
  if (!principal.permissions.has(needed)) throw forbidden();
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
    return this.staffDetail(row, executor);
  }

  async staffDetail(
    row: TicketViewRow,
    executor: Executor = this.database.db,
  ): Promise<TicketDetail> {
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
      ...toSummary(row, this.keys),
      requester:
        row.t.requesterContactId && row.requesterName !== null
          ? { id: row.t.requesterContactId, name: row.requesterName, email: row.requesterEmail }
          : null,
      mergedTickets: children.map((child) => ({
        id: child.id,
        key: this.keys.format(child.number),
        subject: child.subject,
      })),
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
    return {
      ticketId: source.t.id,
      items: rows.map((row) =>
        client ? toClientTicket(row, this.keys) : toSummary(row, this.keys),
      ),
    };
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

    const conditions: (SQL | undefined)[] = [
      // Every query a client runs is limited to their organization, whatever else they ask for.
      orgScopeCondition(ticket.orgId, principal.orgScope),
      client ? undefined : query.orgId === undefined ? undefined : eq(ticket.orgId, query.orgId),
      query.status === undefined ? undefined : inArray(ticket.status, query.status),
      query.priority === undefined ? undefined : inArray(ticket.priority, query.priority),
      query.intentId === undefined ? undefined : eq(ticket.intentId, query.intentId),
    ];
    if (!client) {
      if (query.assignee === 'unassigned') conditions.push(isNull(ticket.assigneeId));
      else if (query.assignee === 'me') conditions.push(eq(ticket.assigneeId, principal.userId));
      else if (query.assignee !== undefined) conditions.push(eq(ticket.assigneeId, query.assignee));
      if (query.queueId !== undefined) conditions.push(eq(ticket.queueId, query.queueId));
      if (query.channel !== undefined) conditions.push(eq(ticket.channel, query.channel));
      if (query.tag !== undefined) conditions.push(arrayContains(ticket.tags, [query.tag]));
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
      const pattern = likeContains(query.q);
      conditions.push(
        or(
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
    return {
      items: page.rows.map((entry) =>
        client ? toClientTicket(entry.row, this.keys) : toSummary(entry.row, this.keys),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
