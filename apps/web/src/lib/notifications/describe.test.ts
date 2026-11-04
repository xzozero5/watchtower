import { NOTIFICATION_KINDS, OPS_NOTIFICATION_KINDS, type Notification } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { getMessages, translate } from '@/i18n';

import { kindMessageKey, kindNameKey, kindValues } from './describe';

const item = (kind: Notification['kind'], data: Notification['data'] = {}): Notification => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind,
  severity: 'high',
  orgId: null,
  queueId: null,
  channel: null,
  ticket: null,
  data,
  createdAt: '2026-11-04T10:00:00.000Z',
  readAt: null,
});

describe('notification kinds', () => {
  it('every kind, the system ones (T-176) included, has a sentence and a setting name in both languages', () => {
    for (const locale of ['en', 'th'] as const) {
      const messages = getMessages(locale);
      for (const kind of NOTIFICATION_KINDS) {
        for (const key of [kindMessageKey(kind), kindNameKey(kind)]) {
          const text = translate(messages, key, { key: 'WT-1', count: 3 });
          expect(text, `${locale} ${key}`).not.toBe(key);
          expect(text.length).toBeGreaterThan(5);
        }
      }
    }
  });

  it('the outbox notice shows the count it carries', () => {
    expect(OPS_NOTIFICATION_KINDS).toContain('ops.outbox_dead');
    const values = kindValues(item('ops.outbox_dead', { count: 4 }));
    expect(translate(getMessages('en'), kindMessageKey('ops.outbox_dead'), values)).toContain('4');
  });
});
