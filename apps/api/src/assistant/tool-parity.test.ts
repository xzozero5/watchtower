import { DEFAULT_ROLE_PERMISSIONS, ROLES, type Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluatePermissionRule,
  evaluatePermissionRules,
  type PermissionRule,
} from '../auth/permission-check.js';
import { collectRoutes } from '../testing/route-table.js';
import { ASSISTANT_TOOLS, ROLE_TOOLS, TOOL_PERMISSION, toolsFor } from './assistant-access.js';
import {
  authorizationDisagreements,
  leaksBeyondRoute,
  permissionSetsToTry,
  routeRules,
  sameAsRoute,
} from './tool-parity.js';

const roleSets = ROLES.map((role) => DEFAULT_ROLE_PERMISSIONS[role]);

describe('tool permission parity (T-400 C-1)', () => {
  it('declares a rule, a GET route and the personal data kinds for every tool', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(TOOL_PERMISSION[tool], tool).toBeDefined();
      expect(TOOL_PERMISSION[tool].route, tool).toMatch(/^GET \/v1\//);
      expect(Array.isArray(TOOL_PERMISSION[tool].piiKinds), tool).toBe(true);
    }
    expect(TOOL_PERMISSION.search_tickets.piiKinds).toEqual(['ticket']);
    expect(TOOL_PERMISSION.summarize_ticket.piiKinds).toEqual(['ticket']);
    expect(TOOL_PERMISSION.team_load.piiKinds).toEqual([]);
  });

  it('asks what the declared GET route asks, and lets nobody in whom the route would refuse', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    for (const tool of ASSISTANT_TOOLS) {
      const { route: key, rule } = TOOL_PERMISSION[tool];
      const route = routes.get(key);
      expect(route, `${tool}: ${key} is a route`).toBeDefined();
      if (route === undefined) continue;
      expect(route.isPublic, tool).toBe(false);
      const rules = routeRules(route);
      expect(
        sameAsRoute(rule, rules),
        `${tool}: declared ${JSON.stringify(rule)}, route ${JSON.stringify(rules)}`,
      ).toBe(true);
      const sets = permissionSetsToTry([rule, ...rules], roleSets);
      expect(authorizationDisagreements(rule, rules, sets), tool).toEqual([]);
    }
  });

  it('gives every role only the tools whose GET route that role may call, a developer included', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    for (const role of ROLES) {
      const principal = { role, permissions: new Set(DEFAULT_ROLE_PERMISSIONS[role]) };
      for (const tool of toolsFor(principal)) {
        const route = routes.get(TOOL_PERMISSION[tool].route);
        expect(
          route !== undefined && evaluatePermissionRules(principal, routeRules(route)),
          `${role} gets ${tool}, whose route ${TOOL_PERMISSION[tool].route} refuses them`,
        ).toBe(true);
      }
    }
  });

  it('keeps a developer (masked read, no ticket.read) out of every tool whose route needs ticket.read', () => {
    const dev = { role: 'dev' as const, permissions: new Set(DEFAULT_ROLE_PERMISSIONS.dev) };
    const tools = toolsFor(dev);
    expect(tools).toEqual(['search_tickets', 'summarize_ticket', 'explain_sla', 'investigate_run']);
    // `ticket.read.masked` stands in for `ticket.read` only where the rule lists both.
    expect(evaluatePermissionRule(dev, { all: ['ticket.read'] })).toBe(false);
    expect(evaluatePermissionRule(dev, { anyOf: ['ticket.read', 'ticket.read.masked'] })).toBe(
      true,
    );
    for (const tool of ASSISTANT_TOOLS) {
      const rule = TOOL_PERMISSION[tool].rule;
      if ('all' in rule && rule.all.includes('ticket.read'))
        expect(tools, tool).not.toContain(tool);
    }
    // Even a role list that named team_load for a developer would not give it to them.
    expect(ROLE_TOOLS.dev).not.toContain('team_load');
    expect(
      toolsFor({ role: 'lead', permissions: new Set<Permission>(['ticket.read.masked']) }),
    ).toEqual(['search_tickets', 'summarize_ticket', 'explain_sla']);
  });

  it('catches a tool that is wider than its route (the harness itself)', () => {
    const wide: PermissionRule = { anyOf: ['ticket.read', 'ticket.read.masked'] };
    const route: PermissionRule[] = [{ all: ['ticket.read'] }];
    const found = authorizationDisagreements(
      wide,
      route,
      permissionSetsToTry([wide, ...route], roleSets),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => entry.held.includes('ticket.read.masked'))).toBe(true);
    expect(sameAsRoute(wide, route)).toBe(false);
  });
});

describe('output within the route (the helper)', () => {
  const route = {
    items: [
      { key: 'OPS-12', subject: 'Cannot sign in', org: { id: 'o1', name: 'Acme' }, count: 3 },
      { key: 'OPS-13', subject: 'A long   message\nwith space', org: { id: 'o1', name: 'Acme' } },
    ],
  };

  it('accepts what the route shows, shortened or with squashed space', () => {
    expect(
      leaksBeyondRoute(
        { items: [{ key: 'OPS-12', subject: 'Cannot sign in', org: 'Acme', count: 3 }] },
        route,
      ),
    ).toEqual([]);
    expect(leaksBeyondRoute({ text: 'A long message with space' }, route)).toEqual([]);
    expect(leaksBeyondRoute({ text: 'A long mess…' }, route)).toEqual([]);
  });

  it('names what the route does not show', () => {
    expect(
      leaksBeyondRoute({ items: [{ key: 'OPS-12', requester: 'Jane Doe', count: 99 }] }, route),
    ).toEqual(['items.0.requester', 'items.0.count']);
    expect(
      leaksBeyondRoute({ verdict: 'high', n: 7 }, route, { derived: (path) => path === 'verdict' }),
    ).toEqual(['n']);
  });
});
