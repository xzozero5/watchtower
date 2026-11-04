import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { toDeliverySummary } from '@watchtower/domain';
import {
  CLIENT_HIDDEN_DELIVERY_STATUSES,
  INCIDENTS_TICKET_EVENTS,
  TICKET_EVENT_TYPES,
  formatIncidentKey,
  type ChannelType,
  type DeliverySummary,
  type TimelineEntry,
  type TimelineQuery,
  type UploadScanState,
} from '@watchtower/shared';
import { WORKSPACE_ROLES } from '@watchtower/shared';
import { and, asc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';

import type { Principal } from '../auth/principal.js';
import { afterCursor, decodeCursor, encodeCursor, preciseTimestamp } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { UploadScanGate } from '../storage/upload-scan-gate.js';
import { maskEntry, toMessage, toTimelineEvent, type Audience } from './message-view.js';
import { TicketReader, isClient, isMasked } from './ticket-reader.js';
import { TICKET_KEYS, type TicketKeys } from './ticket-keys.js';

/**
 * The conversation of a ticket (R-1.3): customer messages, public replies, internal notes and the
 * ticket events (status changes, assignment, merges, SLA), oldest first.
 *
 * Merged tickets: the timeline of a ticket also carries everything of the tickets merged into it,
 * each entry naming the ticket it came from, so merging loses no history.
 *
 * A client's timeline holds public messages and public events only, with staff identities and
 * staff-only payload fields removed (`toMessage`, `toTimelineEvent`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EventNames {
  readonly users: ReadonlyMap<string, string>;
  readonly queues: ReadonlyMap<string, string>;
  readonly incidents: ReadonlyMap<string, { key: string; title: string | null }>;
}

/**
 * Adds `fromName` / `toName` / `queueName` to an assignment and `incidentKey` / `incidentTitle` to an
 * incident link, so the UI can say "Assignee: Mana K. to Pim S." (T-144). Other entries pass through.
 */
export function withNames(entry: TimelineEntry, names: EventNames | null): TimelineEntry {
  if (names === null || entry.kind !== 'event') return entry;
  const payload = entry.payload;
  const lookup = (value: unknown, map: ReadonlyMap<string, string>): string | undefined =>
    typeof value === 'string' ? map.get(value) : undefined;
  if (entry.type === TICKET_EVENT_TYPES.assigned) {
    const fromName = lookup(payload.from, names.users);
    const toName = lookup(payload.to, names.users);
    const queueName = lookup(payload.queueId, names.queues);
    return {
      ...entry,
      payload: {
        ...payload,
        ...(fromName === undefined ? {} : { fromName }),
        ...(toName === undefined ? {} : { toName }),
        ...(queueName === undefined ? {} : { queueName }),
      },
    };
  }
  if (
    entry.type === INCIDENTS_TICKET_EVENTS.incidentLinked ||
    entry.type === INCIDENTS_TICKET_EVENTS.incidentUnlinked
  ) {
    const found =
      typeof payload.incidentId === 'string' ? names.incidents.get(payload.incidentId) : undefined;
    if (found === undefined) return entry;
    return {
      ...entry,
      payload: {
        ...payload,
        incidentKey: found.key,
        ...(found.title === null ? {} : { incidentTitle: found.title }),
      },
    };
  }
  return entry;
}

@Injectable()
export class TimelineService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(UploadScanGate) private readonly scanGate: UploadScanGate,
  ) {}

  async timeline(
    ref: string,
    query: TimelineQuery,
    principal: Principal,
  ): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
    const root = await this.reader.viewRow(ref, principal);
    const audience: Audience = isClient(principal) ? 'client' : 'staff';
    // A developer reads the same conversation with personal data masked (T-137), one session for the page.
    const session = isMasked(principal) ? await this.reader.maskingFor(root.t.id, [root]) : null;
    // People of the customer's side are customers: a client user's name is personal data (the magic-link
    // sign-in even sets it to the local part of the email address). Staff names stay.
    const shownName = (name: string | null, role: string | null): string | null =>
      session !== null &&
      name !== null &&
      !(WORKSPACE_ROLES as readonly string[]).includes(role ?? '')
        ? session.name(name)
        : name;
    const { message, ticketEvent, ticket, users, contact } = schema;

    // No event of a ticket is older than the ticket. The events table is partitioned by month, and
    // this bound lets Postgres skip every partition before the ticket existed. A day of slack: the
    // ticket's own timestamp comes from the application clock and the event's from the database
    // transaction start, so they can differ by the clock skew between the two machines.
    let earliest = root.t.createdAt;
    const numbers = new Map<string, { number: number; channel: ChannelType }>([
      [root.t.id, { number: root.t.number, channel: root.t.channel as ChannelType }],
    ]);
    if (query.includeMerged) {
      const children = await this.database.db
        .select({
          id: ticket.id,
          number: ticket.number,
          channel: ticket.channel,
          createdAt: ticket.createdAt,
        })
        .from(ticket)
        // Merging never crosses organizations, so the children are in the caller's organization too.
        .where(and(eq(ticket.parentTicketId, root.t.id), eq(ticket.orgId, root.t.orgId)));
      for (const child of children) {
        numbers.set(child.id, { number: child.number, channel: child.channel as ChannelType });
        if (child.createdAt < earliest) earliest = child.createdAt;
      }
    }
    const ids = [...numbers.keys()];
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    const messages = await this.database.db
      .select({
        row: message,
        sortKey: preciseTimestamp(message.createdAt),
        userName: users.name,
        userRole: users.role,
        contactName: contact.name,
      })
      .from(message)
      .leftJoin(users, eq(users.id, message.senderUserId))
      .leftJoin(contact, eq(contact.id, message.senderContactId))
      .where(
        and(
          inArray(message.ticketId, ids),
          audience === 'client' ? eq(message.visibility, 'public') : undefined,
          // A reply that has not reached the customer is not theirs to see (ADR-010).
          audience === 'client'
            ? notInArray(message.deliveryStatus, [...CLIENT_HIDDEN_DELIVERY_STATUSES])
            : undefined,
          cursor ? afterCursor(message.createdAt, message.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(message.createdAt), asc(message.id))
      .limit(query.limit + 1);

    // Staff see the delivery behind a reply on Gmail or LINE (Undo, Retry). The newest one per message.
    const deliveries = new Map<string, DeliverySummary>();
    const outboundIds = messages
      .filter((entry) => entry.row.direction === 'outbound')
      .map((entry) => entry.row.id);
    if (audience === 'staff' && outboundIds.length > 0) {
      const rows = await this.database.db
        .select()
        .from(schema.outboundDelivery)
        .where(inArray(schema.outboundDelivery.messageId, outboundIds))
        .orderBy(asc(schema.outboundDelivery.createdAt));
      const now = new Date();
      for (const row of rows) deliveries.set(row.messageId, toDeliverySummary(row, now));
    }

    // ADR-022: with the malware scan on, staff see where each file stands.
    let scanStates: ReadonlyMap<string, UploadScanState> | undefined;
    if (audience === 'staff' && this.scanGate.enabled) {
      const keys = messages.flatMap((entry) =>
        (Array.isArray(entry.row.attachments)
          ? (entry.row.attachments as { objectKey?: unknown }[])
          : []
        ).flatMap((attachment) =>
          typeof attachment.objectKey === 'string' ? [attachment.objectKey] : [],
        ),
      );
      if (keys.length > 0) scanStates = await this.scanGate.states(keys);
    }

    const events = await this.database.db
      .select({
        row: ticketEvent,
        sortKey: preciseTimestamp(ticketEvent.createdAt),
        actorName: users.name,
        actorRole: users.role,
      })
      .from(ticketEvent)
      .leftJoin(users, sql`${users.id}::text = ${ticketEvent.actorId}`)
      .where(
        and(
          inArray(ticketEvent.ticketId, ids),
          gte(
            ticketEvent.createdAt,
            sql`${earliest.toISOString()}::timestamptz - interval '1 day'`,
          ),
          audience === 'client' ? eq(ticketEvent.visibility, 'public') : undefined,
          cursor ? afterCursor(ticketEvent.createdAt, ticketEvent.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(ticketEvent.createdAt), asc(ticketEvent.id))
      .limit(query.limit + 1);

    // Staff read who an assignment moved from and to, and which incident a link points at, by name:
    // the event itself holds ids only (T-144). A client never gets these events' payload at all.
    const names = audience === 'staff' ? await this.eventNames(events, session === null) : null;

    // Two sorted streams, each cut at limit + 1, merge into the correct first `limit` entries.
    const merged = [
      ...messages.map((entry) => ({
        sortKey: entry.sortKey,
        id: entry.row.id,
        build: (): TimelineEntry => {
          const known = numbers.get(entry.row.ticketId);
          return {
            kind: 'message',
            ...toMessage(entry.row, {
              ticketKey: this.keys.format(known?.number ?? root.t.number),
              channel: known?.channel ?? (root.t.channel as ChannelType),
              senderUserName: shownName(entry.userName, entry.userRole),
              senderUserRole: entry.userRole,
              senderContactName: entry.contactName,
              audience,
              ...(scanStates === undefined ? {} : { scanStates }),
              ...(deliveries.has(entry.row.id)
                ? { delivery: deliveries.get(entry.row.id) ?? null }
                : {}),
            }),
          };
        },
      })),
      ...events.map((entry) => ({
        sortKey: entry.sortKey,
        id: entry.row.id,
        build: (): TimelineEntry =>
          withNames(
            toTimelineEvent(entry.row, {
              ticketKey: this.keys.format(numbers.get(entry.row.ticketId)?.number ?? root.t.number),
              actorName: shownName(entry.actorName, entry.actorRole),
              audience,
            }),
            names,
          ),
      })),
    ].sort((a, b) => {
      // Plain string order, the same as Postgres' for fixed-width timestamps and lower-case uuids.
      if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    const page = merged.slice(0, query.limit);
    const last = page.at(-1);
    return {
      entries: page.map((entry) => {
        const built = entry.build();
        return session === null ? built : maskEntry(built, session);
      }),
      nextCursor:
        merged.length > query.limit && last ? encodeCursor({ v: last.sortKey, id: last.id }) : null,
    };
  }

  /** Names for the ids that staff-visible events carry: people (assignments) and incidents (links). */
  private async eventNames(
    events: readonly { row: { type: string; payload: unknown } }[],
    showTitles: boolean,
  ): Promise<EventNames> {
    const userIds = new Set<string>();
    const queueIds = new Set<string>();
    const incidentIds = new Set<string>();
    for (const { row } of events) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      if (row.type === TICKET_EVENT_TYPES.assigned) {
        for (const key of ['from', 'to'] as const) {
          const value = payload[key];
          if (typeof value === 'string' && UUID.test(value)) userIds.add(value);
        }
        if (typeof payload.queueId === 'string' && UUID.test(payload.queueId)) {
          queueIds.add(payload.queueId);
        }
      }
      if (
        (row.type === INCIDENTS_TICKET_EVENTS.incidentLinked ||
          row.type === INCIDENTS_TICKET_EVENTS.incidentUnlinked) &&
        typeof payload.incidentId === 'string' &&
        UUID.test(payload.incidentId)
      ) {
        incidentIds.add(payload.incidentId);
      }
    }
    const db = this.database.db;
    const people =
      userIds.size === 0
        ? []
        : await db
            .select({ id: schema.users.id, name: schema.users.name })
            .from(schema.users)
            .where(inArray(schema.users.id, [...userIds]));
    const queues =
      queueIds.size === 0
        ? []
        : await db
            .select({ id: schema.teamQueue.id, name: schema.teamQueue.name })
            .from(schema.teamQueue)
            .where(inArray(schema.teamQueue.id, [...queueIds]));
    const incidents =
      incidentIds.size === 0
        ? []
        : await db
            .select({
              id: schema.incident.id,
              number: schema.incident.number,
              title: schema.incident.title,
            })
            .from(schema.incident)
            .where(inArray(schema.incident.id, [...incidentIds]));
    return {
      users: new Map(people.map((row) => [row.id, row.name])),
      queues: new Map(queues.map((row) => [row.id, row.name])),
      incidents: new Map(
        incidents.map((row) => [
          row.id,
          { key: formatIncidentKey(row.number), title: showTitles ? row.title : null },
        ]),
      ),
    };
  }
}
