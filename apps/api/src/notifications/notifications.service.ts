import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  NOTIFICATION_KINDS,
  isMandatoryNotification,
  notificationKindSchema,
  notificationSeveritySchema,
  ticketPrioritySchema,
  type Notification,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationPreferences,
  type SetNotificationPreferences,
} from '@watchtower/shared';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import { notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';

/**
 * Reads and marks the caller's own notifications, and their preferences. Every query is filtered on
 * the caller's user id: there is no way to name another person's notification, so someone else's id
 * answers 404, the same as an id that does not exist.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  async list(userId: string, query: NotificationListQuery): Promise<NotificationPage> {
    const { notification, ticket } = schema;
    const rows = await this.database.db
      .select({
        row: notification,
        ticketNumber: ticket.number,
        ticketSubject: ticket.subject,
        ticketPriority: ticket.priority,
        ticketStatus: ticket.status,
        sortKey: preciseTimestamp(notification.createdAt),
      })
      .from(notification)
      .leftJoin(ticket, eq(ticket.id, notification.ticketId))
      .where(
        and(
          eq(notification.userId, userId),
          query.unread === true ? isNull(notification.readAt) : undefined,
          query.cursor === undefined
            ? undefined
            : beforeCursor(notification.createdAt, notification.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ ...entry, id: entry.row.id })),
      query.limit,
    );
    return {
      items: page.rows.map((entry): Notification => ({
        id: entry.row.id,
        kind: notificationKindSchema.parse(entry.row.kind),
        severity: notificationSeveritySchema.parse(entry.row.severity),
        orgId: entry.row.orgId,
        queueId: entry.row.queueId,
        channel: entry.row.channel,
        ticket:
          entry.row.ticketId === null || entry.ticketNumber === null
            ? null
            : {
                id: entry.row.ticketId,
                key: this.keys.format(entry.ticketNumber),
                subject: entry.ticketSubject ?? '',
                priority: ticketPrioritySchema.parse(entry.ticketPriority),
                status: entry.ticketStatus ?? '',
              },
        data: entry.row.data,
        createdAt: entry.row.createdAt.toISOString(),
        readAt: entry.row.readAt?.toISOString() ?? null,
      })),
      unreadCount: await this.unreadCount(userId),
      nextCursor: page.nextCursor,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(schema.notification)
      .where(and(eq(schema.notification.userId, userId), isNull(schema.notification.readAt)));
    return row?.value ?? 0;
  }

  /** Marks one of the caller's notifications read (idempotent: reading twice keeps the first time). */
  async markRead(userId: string, id: string): Promise<void> {
    const { notification } = schema;
    const [owned] = await this.database.db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.id, id), eq(notification.userId, userId)))
      .limit(1);
    if (owned === undefined) throw notFound('No such notification');
    await this.database.db
      .update(notification)
      .set({ readAt: sql`now()` })
      .where(
        and(eq(notification.id, id), eq(notification.userId, userId), isNull(notification.readAt)),
      );
  }

  async markAllRead(userId: string): Promise<number> {
    const { notification } = schema;
    const updated = await this.database.db
      .update(notification)
      .set({ readAt: sql`now()` })
      .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
      .returning({ id: notification.id });
    return updated.length;
  }

  async preferences(userId: string): Promise<NotificationPreferences> {
    const rows = await this.database.db
      .select({
        kind: schema.notificationPreference.kind,
        inApp: schema.notificationPreference.inApp,
      })
      .from(schema.notificationPreference)
      .where(eq(schema.notificationPreference.userId, userId));
    const chosen = new Map(rows.map((row) => [row.kind, row.inApp]));
    return {
      preferences: NOTIFICATION_KINDS.map((kind) => ({
        kind,
        inApp: isMandatoryNotification(kind) ? true : (chosen.get(kind) ?? true),
        mandatory: isMandatoryNotification(kind),
      })),
    };
  }

  async setPreferences(
    userId: string,
    input: SetNotificationPreferences,
  ): Promise<NotificationPreferences> {
    await this.database.db
      .insert(schema.notificationPreference)
      .values(input.preferences.map((entry) => ({ userId, kind: entry.kind, inApp: entry.inApp })))
      .onConflictDoUpdate({
        target: [schema.notificationPreference.userId, schema.notificationPreference.kind],
        set: { inApp: sql`excluded.in_app`, updatedAt: sql`now()` },
      });
    return this.preferences(userId);
  }
}
