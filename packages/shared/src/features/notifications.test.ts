import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_KINDS,
  isMandatoryNotification,
  notificationListQuerySchema,
  setNotificationPreferencesSchema,
} from './notifications.js';

describe('notification preferences', () => {
  it('accepts a change to an optional kind', () => {
    const parsed = setNotificationPreferencesSchema.safeParse({
      preferences: [{ kind: 'ticket.assigned', inApp: false }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses to turn P1 off, but accepts it on', () => {
    expect(
      setNotificationPreferencesSchema.safeParse({
        preferences: [{ kind: 'ticket.p1', inApp: false }],
      }).success,
    ).toBe(false);
    expect(
      setNotificationPreferencesSchema.safeParse({
        preferences: [{ kind: 'ticket.p1', inApp: true }],
      }).success,
    ).toBe(true);
  });

  it('refuses a repeated kind, an unknown kind and an empty list', () => {
    expect(
      setNotificationPreferencesSchema.safeParse({
        preferences: [
          { kind: 'shift.no_show', inApp: true },
          { kind: 'shift.no_show', inApp: false },
        ],
      }).success,
    ).toBe(false);
    expect(
      setNotificationPreferencesSchema.safeParse({ preferences: [{ kind: 'x', inApp: true }] })
        .success,
    ).toBe(false);
    expect(setNotificationPreferencesSchema.safeParse({ preferences: [] }).success).toBe(false);
  });

  it('marks only P1 as mandatory', () => {
    expect(NOTIFICATION_KINDS.filter(isMandatoryNotification)).toEqual(['ticket.p1']);
  });
});

describe('notification list query', () => {
  it('defaults the page size and reads unread as a boolean', () => {
    expect(notificationListQuerySchema.parse({})).toMatchObject({ limit: 30 });
    expect(notificationListQuerySchema.parse({ unread: 'true' }).unread).toBe(true);
    expect(notificationListQuerySchema.parse({ unread: 'false' }).unread).toBe(false);
    expect(notificationListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ unread: 'yes' }).success).toBe(false);
  });
});
