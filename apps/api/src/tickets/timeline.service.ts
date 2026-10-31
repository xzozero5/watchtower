import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { ChannelType, TimelineEntry, TimelineQuery } from '@watchtower/shared';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Principal } from '../auth/principal.js';
import { afterCursor, decodeCursor, encodeCursor, preciseTimestamp } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { toMessage, toTimelineEvent, type Audience } from './message-view.js';
import { TicketReader, isClient } from './ticket-reader.js';
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
@Injectable()
export class TimelineService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  async timeline(
    ref: string,
    query: TimelineQuery,
    principal: Principal,
  ): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
    const root = await this.reader.viewRow(ref, principal);
    const audience: Audience = isClient(principal) ? 'client' : 'staff';
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
          cursor ? afterCursor(message.createdAt, message.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(message.createdAt), asc(message.id))
      .limit(query.limit + 1);

    const events = await this.database.db
      .select({
        row: ticketEvent,
        sortKey: preciseTimestamp(ticketEvent.createdAt),
        actorName: users.name,
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
              senderUserName: entry.userName,
              senderUserRole: entry.userRole,
              senderContactName: entry.contactName,
              audience,
            }),
          };
        },
      })),
      ...events.map((entry) => ({
        sortKey: entry.sortKey,
        id: entry.row.id,
        build: (): TimelineEntry =>
          toTimelineEvent(entry.row, {
            ticketKey: this.keys.format(numbers.get(entry.row.ticketId)?.number ?? root.t.number),
            actorName: entry.actorName,
            audience,
          }),
      })),
    ].sort((a, b) => {
      // Plain string order, the same as Postgres' for fixed-width timestamps and lower-case uuids.
      if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    const page = merged.slice(0, query.limit);
    const last = page.at(-1);
    return {
      entries: page.map((entry) => entry.build()),
      nextCursor:
        merged.length > query.limit && last ? encodeCursor({ v: last.sortKey, id: last.id }) : null,
    };
  }
}
