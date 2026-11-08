import {
  DEFAULT_ROLE_PERMISSIONS,
  INSIGHT_ELEMENT_KEYS,
  INSIGHT_ELEMENTS,
  type InsightFact,
  type Permission,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { insightRuleAllows, type InsightViewer } from './insight-access.js';
import { builderFor } from './insight-builders.js';
import { refKey, restoreNarration, type ResolvedRef } from './insight-claims.js';

interface TestRoleSpec {
  name: string;
  role: 'head' | 'lead' | 'agent' | 'dev' | 'client' | 'system';
  permissions: Set<Permission>;
}

const TEST_ROLES: TestRoleSpec[] = [
  {
    name: 'head',
    role: 'head',
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.head),
  },
  {
    name: 'lead',
    role: 'lead',
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.lead),
  },
  {
    name: 'l2',
    role: 'agent',
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.agent),
  },
  {
    name: 'l1',
    role: 'agent',
    permissions: new Set<Permission>(['ticket.read', 'ticket.reply', 'assistant.use']),
  },
  {
    name: 'viewer',
    role: 'agent',
    permissions: new Set<Permission>(['ticket.read', 'alert.read', 'kb.read', 'assistant.use']),
  },
  {
    name: 'dev',
    role: 'dev',
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.dev),
  },
  {
    name: 'client',
    role: 'client',
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.client),
  },
];

describe('T-421 QA Gate: RBAC Matrix (43 Elements × 7 Roles) & Registry Completeness', () => {
  describe('Registry Structure & Completeness (AC-J15, AC-J19)', () => {
    it('has exactly 43 elements in INSIGHT_ELEMENT_KEYS matching INSIGHT_ELEMENTS', () => {
      expect(INSIGHT_ELEMENT_KEYS).toHaveLength(43);
      expect(Object.keys(INSIGHT_ELEMENTS).sort()).toEqual([...INSIGHT_ELEMENT_KEYS].sort());
    });

    it('has exactly 36 non-X elements and every one has askAi === true', () => {
      const nonX = INSIGHT_ELEMENT_KEYS.filter((k) => INSIGHT_ELEMENTS[k].mode !== 'X');
      expect(nonX).toHaveLength(36);
      for (const key of nonX) {
        expect(INSIGHT_ELEMENTS[key].askAi, `${key} must have askAi: true`).toBe(true);
      }
    });

    it('has exactly 7 mode X elements, and every one has askAi === false and rule === null', () => {
      const modeX = INSIGHT_ELEMENT_KEYS.filter((k) => INSIGHT_ELEMENTS[k].mode === 'X');
      expect(modeX).toHaveLength(7);
      for (const key of modeX) {
        expect(INSIGHT_ELEMENTS[key].askAi, `${key} must have askAi: false`).toBe(false);
        expect(INSIGHT_ELEMENTS[key].rule, `${key} must have rule: null`).toBeNull();
      }
    });

    it('every element where mode is F or N has builderFor registered for its source', () => {
      const fnElements = INSIGHT_ELEMENT_KEYS.filter(
        (k) => INSIGHT_ELEMENTS[k].mode === 'F' || INSIGHT_ELEMENTS[k].mode === 'N',
      );
      // Mode F or N elements count: 30 elements
      expect(fnElements).toHaveLength(30);

      for (const key of fnElements) {
        const element = INSIGHT_ELEMENTS[key];
        const source = element.aliasOf ?? key;
        const builder = builderFor(source);
        expect(builder, `Builder must exist for source ${source} of element ${key}`).toBeDefined();
        expect(typeof builder).toBe('function');
      }
    });

    it('every element with adminFactsOnly === true is strictly mode === F', () => {
      const adminFactsOnly = INSIGHT_ELEMENT_KEYS.filter(
        (k) => INSIGHT_ELEMENTS[k].adminFactsOnly === true,
      );
      expect(adminFactsOnly.length).toBeGreaterThan(0);
      for (const key of adminFactsOnly) {
        expect(INSIGHT_ELEMENTS[key].mode, `${key} must be mode F`).toBe('F');
      }
    });
  });

  describe('Exhaustive RBAC Matrix: 43 Elements × 7 Roles', () => {
    it('client is denied 100% of all 43 elements (always false / 403)', () => {
      const clientViewer: InsightViewer = {
        userId: '11111111-1111-4111-8111-111111111111',
        role: 'client',
        permissions: new Set(DEFAULT_ROLE_PERMISSIONS.client),
      };

      for (const key of INSIGHT_ELEMENT_KEYS) {
        const allowed = insightRuleAllows(clientViewer, INSIGHT_ELEMENTS[key]);
        expect(allowed, `Client must NEVER be allowed access to ${key}`).toBe(false);
      }
    });

    it('enforces deny-by-default when a viewer lacks the rule permissions', () => {
      const emptyViewer: InsightViewer = {
        userId: '22222222-2222-4222-8222-222222222222',
        role: 'agent',
        permissions: new Set(),
      };

      for (const key of INSIGHT_ELEMENT_KEYS) {
        const allowed = insightRuleAllows(emptyViewer, INSIGHT_ELEMENTS[key]);
        expect(allowed, `Viewer with 0 permissions must be denied ${key}`).toBe(false);
      }
    });

    it('evaluates permission rules for all 7 roles across all 43 elements', () => {
      const roleMatrix = new Map<string, Record<string, boolean>>();

      for (const roleSpec of TEST_ROLES) {
        const row: Record<string, boolean> = {};
        roleMatrix.set(roleSpec.name, row);
        const viewer: InsightViewer = {
          userId: '33333333-3333-4333-8333-333333333333',
          role: roleSpec.role,
          permissions: roleSpec.permissions,
        };

        for (const key of INSIGHT_ELEMENT_KEYS) {
          const element = INSIGHT_ELEMENTS[key];
          const allowed = insightRuleAllows(viewer, element);
          row[key] = allowed;

          if (roleSpec.role === 'client') {
            expect(allowed).toBe(false);
          } else if (element.mode === 'X' || element.rule === null) {
            expect(allowed).toBe(false);
          } else {
            // Verify evaluation matches rule specification
            if ('all' in element.rule) {
              const expected = element.rule.all.every((p) => roleSpec.permissions.has(p));
              expect(allowed, `${roleSpec.name} on ${key}`).toBe(expected);
            } else {
              const expected = element.rule.anyOf.some((p) => roleSpec.permissions.has(p));
              expect(allowed, `${roleSpec.name} on ${key}`).toBe(expected);
            }
          }
        }
      }

      // Assert head has widest access among workspace staff
      const headRow = roleMatrix.get('head');
      const l1Row = roleMatrix.get('l1');
      if (!headRow || !l1Row) throw new Error('head or l1 row missing from roleMatrix');
      const headAllowed = Object.values(headRow).filter(Boolean).length;
      const l1Allowed = Object.values(l1Row).filter(Boolean).length;
      expect(headAllowed).toBeGreaterThan(l1Allowed);
    });

    it('dev role is masked and never leaks customer references (org, contact) into claims', () => {
      const devViewer = {
        userId: '44444444-4444-4444-8444-444444444444',
        role: 'dev' as const,
        permissions: new Set(DEFAULT_ROLE_PERMISSIONS.dev),
        orgScope: undefined,
      };

      // Find elements that dev can access
      const devAccessible = INSIGHT_ELEMENT_KEYS.filter((k) =>
        insightRuleAllows(devViewer, INSIGHT_ELEMENTS[k]),
      );
      expect(devAccessible.length).toBeGreaterThan(0);

      const ORG_ID = '22222222-2222-4222-8222-222222222222';
      const INTENT_ID = '11111111-1111-4111-8111-111111111111';

      const facts: InsightFact[] = [
        {
          id: 'created',
          kind: 'metric',
          value: 40,
          display: { th: 'สร้าง 40', en: '40 created' },
        },
      ];

      const resolved = new Map<string, ResolvedRef>([
        [refKey({ kind: 'org', id: ORG_ID }), { allowed: true, label: 'Customer Org' }],
        [refKey({ kind: 'intent', id: INTENT_ID }), { allowed: true, label: 'Billing' }],
      ]);

      const storedClaims = [
        {
          text: 'Org X has 40 tickets',
          evidence: [{ kind: 'org' as const, id: ORG_ID, factId: 'created' }],
        },
        {
          text: '40 tickets total',
          evidence: [{ kind: 'intent' as const, id: INTENT_ID, factId: 'created' }],
        },
      ];

      // For unmasked staff (e.g. head/lead), both claims are restored
      const unmasked = restoreNarration(storedClaims, {
        facts,
        locale: 'en',
        resolved,
        masked: false,
      });
      expect(unmasked).toHaveLength(2);

      // For dev (masked: true), claim citing customer org is dropped 100%!
      const masked = restoreNarration(storedClaims, {
        facts,
        locale: 'en',
        resolved,
        masked: true,
      });
      expect(masked).toHaveLength(1);
      expect(masked[0]?.text).toBe('40 tickets total');
      expect(masked[0]?.evidence.some((e) => e.kind === 'org')).toBe(false);
    });
  });
});
