import {
  DEFAULT_ROLE_PERMISSIONS,
  INSIGHT_ELEMENT_KEYS,
  INSIGHT_ELEMENTS,
  ROLES,
  type InsightRule,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  authorizationDisagreements,
  permissionSetsToTry,
  routeRules,
  sameAsRoute,
} from '../assistant/tool-parity.js';
import { evaluatePermissionRule, type PermissionRule } from '../auth/permission-check.js';
import { collectRoutes } from '../testing/route-table.js';

// ADR-029 section 9.2 / 9.3: the `rule` of an element is the rule of the GET route behind it, so that an insight
// is shown to a person exactly when that route would show them the same scope (T-416). Two checks, on outcomes:
// the registry never lets in anyone the route refuses, and it asks the same permissions (client-only ones aside).

const roleSets = ROLES.map((role) => DEFAULT_ROLE_PERMISSIONS[role]);
const asRule = (rule: InsightRule): PermissionRule => rule;

/**
 * The same rule as the route, or a section of the route (the dashboard's CSAT panel, an admin page): an `all` rule that holds the
 * route's permissions (every one of an `all`, at least one of an `anyOf`) plus the one that unlocks the section.
 */
function sameOrSection(rule: PermissionRule, route: readonly PermissionRule[]): boolean {
  if (sameAsRoute(rule, route)) return true;
  const only = route.length === 1 ? route[0] : undefined;
  if (only === undefined || !('all' in rule)) return false;
  return 'all' in only
    ? only.all.every((permission) => rule.all.includes(permission))
    : only.anyOf.some((permission) => rule.all.includes(permission));
}

describe('element rule parity with its GET route (T-416)', () => {
  it('has a real, authenticated GET route for every element that is shown', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    const missing: string[] = [];
    for (const key of INSIGHT_ELEMENT_KEYS) {
      const element = INSIGHT_ELEMENTS[key];
      if (element.mode === 'X' || element.route === null) continue;
      const route = routes.get(element.route);
      if (route === undefined) missing.push(`${key}: ${element.route}`);
      else expect(route.isPublic, key).toBe(false);
    }
    expect(missing).toEqual([]);
  }, 60_000);

  it('asks what the route asks, and lets nobody in whom the route refuses', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    const wrong: string[] = [];
    for (const key of INSIGHT_ELEMENT_KEYS) {
      const element = INSIGHT_ELEMENTS[key];
      if (element.mode === 'X' || element.route === null || element.rule === null) continue;
      const route = routes.get(element.route);
      if (route === undefined) continue;
      const rules = routeRules(route);
      const rule = asRule(element.rule);
      if (!sameOrSection(rule, rules)) {
        wrong.push(
          `${key}: registry ${JSON.stringify(rule)}, ${element.route} ${JSON.stringify(rules)}`,
        );
      }
      const wider = authorizationDisagreements(
        rule,
        rules,
        permissionSetsToTry([rule, ...rules], roleSets),
      );
      if (wider.length > 0) wrong.push(`${key}: lets in someone the route refuses`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('keeps a masked developer out of the elements whose route needs ticket.read or dashboard.ops.read', () => {
    const dev = { permissions: new Set(DEFAULT_ROLE_PERMISSIONS.dev) };
    for (const key of [
      'home.my_work',
      'home.volume',
      'incidents.open',
      'dashboard.ops.sla',
    ] as const) {
      const rule = INSIGHT_ELEMENTS[key].rule;
      expect(rule, key).not.toBeNull();
      if (rule !== null) expect(evaluatePermissionRule(dev, asRule(rule)), key).toBe(false);
    }
  });
});
