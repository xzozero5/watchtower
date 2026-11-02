import { describe, expect, it } from 'vitest';

import {
  CHANNEL_TYPES,
  MANUAL_CHANNELS,
  TICKET_CHANNELS,
  ticketChannelSchema,
} from './channels.js';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, isPermission } from './rbac.js';

// The Phase 2 permission set (T-200) is [ASSUMED]; migration 0040 seeds the same rows and the db
// integration tests compare them with these defaults.
const PHASE_2 = [
  'alert.read',
  'alert.ack',
  'alert.manage',
  'service.manage',
  'investigate.adhoc',
  'metric.read',
  'metric.manage',
  'org.health.read',
  'dashboard.ops.read',
] as const;

const grantsOf = (role: 'agent' | 'lead' | 'head' | 'client' | 'system') =>
  PHASE_2.filter((key) => DEFAULT_ROLE_PERMISSIONS[role].includes(key)).toSorted();

describe('Phase 2 permissions', () => {
  it('exist with a description', () => {
    for (const key of PHASE_2) {
      expect(isPermission(key), key).toBe(true);
      expect(PERMISSIONS[key].length, key).toBeGreaterThan(10);
    }
  });

  it('give each role the documented grants', () => {
    expect(grantsOf('agent')).toEqual(['alert.ack', 'alert.read', 'dashboard.ops.read']);
    expect(grantsOf('lead')).toEqual(
      [
        'alert.ack',
        'alert.manage',
        'alert.read',
        'dashboard.ops.read',
        'investigate.adhoc',
        'metric.read',
        'org.health.read',
        'service.manage',
      ].toSorted(),
    );
    expect(grantsOf('head')).toEqual([...PHASE_2].toSorted());
  });

  it('grow with seniority', () => {
    const lead = new Set(DEFAULT_ROLE_PERMISSIONS.lead);
    const head = new Set(DEFAULT_ROLE_PERMISSIONS.head);
    for (const key of PHASE_2) {
      if (DEFAULT_ROLE_PERMISSIONS.agent.includes(key)) expect(lead.has(key), key).toBe(true);
      if (lead.has(key)) expect(head.has(key), key).toBe(true);
    }
  });

  it('never reach a client or a system identity, and a usage metric definition is head only', () => {
    expect(grantsOf('client')).toEqual([]);
    expect(grantsOf('system')).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.lead).not.toContain('metric.manage');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('investigate.adhoc');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('org.health.read');
  });
});

describe('ticket channels (T-200)', () => {
  it('add internal to the channels of a channel account, and only for tickets', () => {
    expect(TICKET_CHANNELS).toEqual([...CHANNEL_TYPES, ...MANUAL_CHANNELS, 'internal']);
    expect(ticketChannelSchema.safeParse('internal').success).toBe(true);
    expect(ticketChannelSchema.safeParse('gmail').success).toBe(true);
    expect(ticketChannelSchema.safeParse('sms').success).toBe(false);
    expect(CHANNEL_TYPES as readonly string[]).not.toContain('internal');
  });
});
