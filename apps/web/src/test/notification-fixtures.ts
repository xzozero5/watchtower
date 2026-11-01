import type { Notification, NotificationPage, NotificationPreferences } from '@watchtower/shared';

import { uuid } from './fixtures';
import type { MockHandler } from './mock-api';

/** Time of the fixtures: the tests use fake "now" through `useNow`, so keep it near the real clock. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function makeNotification(n: number, overrides: Partial<Notification> = {}): Notification {
  const key = `OPS-${String(n)}`;
  return {
    id: uuid(3000 + n),
    kind: 'ticket.p1',
    severity: 'critical',
    orgId: uuid(500),
    queueId: null,
    channel: 'gmail',
    ticket: {
      id: uuid(n),
      key,
      subject: `Subject of ${key}`,
      priority: 'P1',
      status: 'open',
    },
    data: {},
    createdAt: minutesAgo(n),
    readAt: null,
    ...overrides,
  };
}

export function page(items: Notification[]): NotificationPage {
  return {
    items,
    unreadCount: items.filter((item) => item.readAt === null).length,
    nextCursor: null,
  };
}

export const PREFERENCES: NotificationPreferences = {
  preferences: [
    { kind: 'ticket.p1', inApp: true, mandatory: true },
    { kind: 'ticket.assigned', inApp: true, mandatory: false },
    { kind: 'shift.handoff_overdue', inApp: true, mandatory: false },
    { kind: 'shift.no_show', inApp: true, mandatory: false },
  ],
};

/**
 * The notification routes of a stateful fake api: the list follows what was marked read, so a
 * test sees the badge and the banner change after a click. `items` is mutated in place.
 */
export function notificationRoutes(items: Notification[]): Record<string, MockHandler> {
  return {
    'GET /v1/notifications': ({ url }) => {
      const unreadOnly = url.searchParams.get('unread') === 'true';
      const shown = unreadOnly ? items.filter((item) => item.readAt === null) : items;
      return {
        json: {
          items: shown,
          unreadCount: items.filter((item) => item.readAt === null).length,
          nextCursor: null,
        },
      };
    },
    'POST /v1/notifications/read-all': () => {
      let updated = 0;
      items.forEach((item, index) => {
        if (item.readAt === null) {
          items[index] = { ...item, readAt: new Date().toISOString() };
          updated += 1;
        }
      });
      return { json: { updated } };
    },
    'POST /v1/notifications/:id/read': ({ params }) => {
      const index = items.findIndex((item) => item.id === params.id);
      const found = items[index];
      if (found && found.readAt === null) {
        items[index] = { ...found, readAt: new Date().toISOString() };
      }
      return { status: 204 };
    },
    'GET /v1/notifications/preferences': { json: PREFERENCES },
    'PUT /v1/notifications/preferences': ({ body }) => {
      const sent = (body as { preferences: { kind: string; inApp: boolean }[] }).preferences;
      return {
        json: {
          preferences: PREFERENCES.preferences.map((entry) => ({
            ...entry,
            inApp: sent.find((change) => change.kind === entry.kind)?.inApp ?? entry.inApp,
          })),
        },
      };
    },
  };
}
