import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_PERMISSIONS,
  HEAD_ONLY_PERMISSIONS,
  PERMISSIONS,
  isHeadOnlyPermission,
  isPermission,
} from './rbac.js';

// The Phase 1 permission set (T-123a) is [ASSUMED]; migration 0006 seeds the same rows and the db
// integration tests compare them with these defaults.
const PHASE_1 = [
  'inbound.read',
  'outbox.manage',
  'view.share',
  'ai.emergency_switch',
  'shift.note.write',
  'handoff.ack',
  'csat.read',
  'ai.run.read',
] as const;

describe('Phase 1 permissions', () => {
  it('exist with a description', () => {
    for (const key of PHASE_1) {
      expect(isPermission(key), key).toBe(true);
      expect(PERMISSIONS[key].length, key).toBeGreaterThan(10);
    }
  });

  it('grow with seniority and never reach a client or a system identity', () => {
    const agent = new Set(DEFAULT_ROLE_PERMISSIONS.agent);
    const lead = new Set(DEFAULT_ROLE_PERMISSIONS.lead);
    const head = new Set(DEFAULT_ROLE_PERMISSIONS.head);
    for (const key of PHASE_1) {
      if (agent.has(key)) expect(lead.has(key), key).toBe(true);
      if (lead.has(key)) expect(head.has(key), key).toBe(true);
      expect(DEFAULT_ROLE_PERMISSIONS.client, key).not.toContain(key);
      expect(DEFAULT_ROLE_PERMISSIONS.system, key).not.toContain(key);
    }
  });

  it('gives each role the documented grants', () => {
    const phase1Of = (role: 'agent' | 'lead' | 'head') =>
      PHASE_1.filter((key) => DEFAULT_ROLE_PERMISSIONS[role].includes(key)).toSorted();
    expect(phase1Of('agent')).toEqual(['handoff.ack', 'inbound.read', 'shift.note.write']);
    expect(phase1Of('lead')).toEqual(
      [
        'ai.emergency_switch',
        'ai.run.read',
        'csat.read',
        'handoff.ack',
        'inbound.read',
        'shift.note.write',
        'view.share',
      ].toSorted(),
    );
    expect(phase1Of('head')).toEqual([...PHASE_1].toSorted());
    // Dead letters are for the head only (PRD section 8.3).
    expect(DEFAULT_ROLE_PERMISSIONS.lead).not.toContain('outbox.manage');
  });
});

describe('head-only permissions', () => {
  it('are held by the head and by no other default role', () => {
    expect(HEAD_ONLY_PERMISSIONS.length).toBeGreaterThan(0);
    for (const key of HEAD_ONLY_PERMISSIONS) {
      expect(isHeadOnlyPermission(key), key).toBe(true);
      expect(DEFAULT_ROLE_PERMISSIONS.head, key).toContain(key);
      for (const role of ['agent', 'lead', 'client', 'system'] as const) {
        expect(DEFAULT_ROLE_PERMISSIONS[role], `${role} ${key}`).not.toContain(key);
      }
    }
    expect(isHeadOnlyPermission('kb.approve')).toBe(false);
  });
});
