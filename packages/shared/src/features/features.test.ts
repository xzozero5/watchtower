import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, CORE_AUDIT_ACTIONS } from '../auth.js';
import { CORE_QUEUE_NAMES, QUEUE_NAMES } from '../queues.js';
import { CORE_TICKET_EVENT_TYPES, TICKET_EVENT_TYPES } from '../ticketing.js';
import { assertDisjoint } from './compose.js';
import { FEATURES, FEATURE_AUDIT_ACTIONS, FEATURE_QUEUES, FEATURE_TICKET_EVENTS } from './index.js';

const EXPECTED_FEATURES = [
  'inbound',
  'outbound',
  'gmail',
  'line',
  'discord',
  'notifications',
  'ai',
  'kb',
  'csat',
  'shifts',
  'autonomy',
  'credentials',
  'views',
];

describe('feature records', () => {
  it('has one entry per Phase 1 feature', () => {
    expect(FEATURES.map((feature) => feature.name)).toEqual(EXPECTED_FEATURES);
  });

  it('composes the global records from the core record plus every feature record', () => {
    expect(AUDIT_ACTIONS).toEqual({ ...CORE_AUDIT_ACTIONS, ...FEATURE_AUDIT_ACTIONS });
    expect(TICKET_EVENT_TYPES).toEqual({ ...CORE_TICKET_EVENT_TYPES, ...FEATURE_TICKET_EVENTS });
    expect(QUEUE_NAMES).toEqual({ ...CORE_QUEUE_NAMES, ...FEATURE_QUEUES });
  });

  it('keeps every core entry the application already uses', () => {
    expect(AUDIT_ACTIONS.ticketCreate).toBe('ticket.create');
    expect(TICKET_EVENT_TYPES.statusChanged).toBe('ticket.status_changed');
    expect(QUEUE_NAMES.email).toBe('email');
  });

  it('never reuses a key or a value of an audit action across core and features', () => {
    const records: Record<string, string>[] = [
      CORE_AUDIT_ACTIONS,
      ...FEATURES.map((feature) => feature.auditActions),
    ];
    expect(() => {
      assertDisjoint('audit actions', records);
    }).not.toThrow();
    // The composition lost nothing to an override.
    const total = records.reduce((sum, record) => sum + Object.keys(record).length, 0);
    expect(Object.keys(AUDIT_ACTIONS)).toHaveLength(total);
  });

  it('never reuses a key or a value of a ticket event type across core and features', () => {
    const records: Record<string, string>[] = [
      CORE_TICKET_EVENT_TYPES,
      ...FEATURES.map((feature) => feature.ticketEvents),
    ];
    expect(() => {
      assertDisjoint('ticket event types', records);
    }).not.toThrow();
    const total = records.reduce((sum, record) => sum + Object.keys(record).length, 0);
    expect(Object.keys(TICKET_EVENT_TYPES)).toHaveLength(total);
  });

  it('never reuses a key or a value of a queue name across core and features', () => {
    const records: Record<string, string>[] = [
      CORE_QUEUE_NAMES,
      ...FEATURES.map((feature) => feature.queues),
    ];
    expect(() => {
      assertDisjoint('queue names', records);
    }).not.toThrow();
    const total = records.reduce((sum, record) => sum + Object.keys(record).length, 0);
    expect(Object.keys(QUEUE_NAMES)).toHaveLength(total);
  });

  it('keeps every queue name a plain lower-case token usable as a BullMQ queue name', () => {
    for (const name of Object.values(QUEUE_NAMES)) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe('assertDisjoint', () => {
  it('accepts records with no shared key and no shared value', () => {
    expect(() => {
      assertDisjoint('x', [{ a: 'one' }, { b: 'two' }, {}]);
    }).not.toThrow();
  });

  it('refuses the same key in two sources, even with different values', () => {
    expect(() => {
      assertDisjoint('AUDIT_ACTIONS', [{ sent: 'gmail.sent' }, { sent: 'line.sent' }]);
    }).toThrow('AUDIT_ACTIONS: key "sent" is defined by more than one source');
  });

  it('refuses the same value under two keys', () => {
    expect(() => {
      assertDisjoint('QUEUE_NAMES', [{ ingest: 'ingest' }, { inbound: 'ingest' }]);
    }).toThrow('QUEUE_NAMES: value "ingest" is used by both "ingest" and "inbound"');
  });
});
