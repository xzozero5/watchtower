import { DEFAULT_ROLE_PERMISSIONS, ROLES, type Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { satisfiesRequirement } from '../auth/permission-check.js';
import { collectRoutes } from '../testing/route-table.js';
import {
  ASSISTANT_TOOLS,
  ROLE_TOOLS,
  TOOL_PERMISSION,
  TOOL_ROUTE,
  toolsFor,
} from './assistant-access.js';
import {
  authorizationDisagreements,
  leaksBeyondRoute,
  permissionSetsToTry,
  sameAsRoute,
} from './tool-parity.js';

const roleSets = ROLES.map((role) => DEFAULT_ROLE_PERMISSIONS[role]);

describe('tool permission parity (T-400 C-1)', () => {
  it('declares a permission and a GET route for every tool', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(TOOL_PERMISSION[tool], tool).toBeDefined();
      expect(TOOL_ROUTE[tool], tool).toMatch(/^GET \/v1\//);
    }
  });

  it('asks what the declared GET route asks, and lets nobody in whom the route would refuse', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    for (const tool of ASSISTANT_TOOLS) {
      const route = routes.get(TOOL_ROUTE[tool]);
      expect(route, `${tool}: ${TOOL_ROUTE[tool]} is a route`).toBeDefined();
      if (route === undefined) continue;
      expect(route.isPublic, tool).toBe(false);
      const required = { all: route.permissions as Permission[], anyOf: route.anyOf as Permission[] };
      // The route has the same shape of decorator (`all` / `anyOf`) as the tool, less customer-only permissions.
      expect(
        sameAsRoute(
          { all: TOOL_PERMISSION[tool].all ?? [], anyOf: TOOL_PERMISSION[tool].anyOf ?? [] },
          required,
        ),
        `${tool}: declared ${JSON.stringify(TOOL_PERMISSION[tool])}, route ${JSON.stringify(required)}`,
      ).toBe(true);
      const requirement = {
        all: route.permissions.length === 0 ? undefined : (route.permissions as Permission[]),
        anyOf: route.anyOf.length === 0 ? undefined : (route.anyOf as Permission[]),
      };
      const sets = permissionSetsToTry([TOOL_PERMISSION[tool], requirement], roleSets);
      expect(authorizationDisagreements(TOOL_PERMISSION[tool], requirement, sets), tool).toEqual([]);
    }
  });

  it('gives every role only the tools whose GET route that role may call, a developer included', async () => {
    const routes = new Map((await collectRoutes()).map((route) => [route.key, route]));
    for (const role of ROLES) {
      const principal = { role, permissions: new Set(DEFAULT_ROLE_PERMISSIONS[role]) };
      for (const tool of toolsFor(principal)) {
        const route = routes.get(TOOL_ROUTE[tool]);
        expect(
          route !== undefined &&
            satisfiesRequirement(principal.permissions, {
              all: route.permissions as Permission[],
              anyOf: route.anyOf.length === 0 ? undefined : (route.anyOf as Permission[]),
            }),
          `${role} gets ${tool}, whose route ${TOOL_ROUTE[tool]} refuses them`,
        ).toBe(true);
      }
    }
  });

  it('keeps a developer (masked read, no ticket.read) out of every tool whose route needs ticket.read', () => {
    const dev = { role: 'dev', permissions: new Set(DEFAULT_ROLE_PERMISSIONS.dev) };
    const tools = toolsFor(dev);
    expect(tools).toEqual(['search_tickets', 'summarize_ticket', 'explain_sla', 'investigate_run']);
    // `ticket.read.masked` stands in for `ticket.read` only where the route lists both.
    expect(satisfiesRequirement(dev.permissions, { all: ['ticket.read'] })).toBe(false);
    expect(satisfiesRequirement(dev.permissions, { anyOf: ['ticket.read', 'ticket.read.masked'] })).toBe(
      true,
    );
    for (const tool of ASSISTANT_TOOLS) {
      if (TOOL_PERMISSION[tool].all?.includes('ticket.read') === true) {
        expect(tools, tool).not.toContain(tool);
      }
    }
    // Even a role list that named team_load for a developer would not give it to them.
    expect(ROLE_TOOLS.dev).not.toContain('team_load');
    expect(toolsFor({ role: 'lead', permissions: new Set<Permission>(['ticket.read.masked']) })).toEqual(
      ['search_tickets', 'summarize_ticket', 'explain_sla'],
    );
  });

  it('catches a tool that is wider than its route (the harness itself)', () => {
    const wide = { anyOf: ['ticket.read', 'ticket.read.masked'] } as const;
    const route = { all: ['ticket.read'] } as const;
    const found = authorizationDisagreements(
      { anyOf: [...wide.anyOf] },
      { all: [...route.all] },
      permissionSetsToTry([wide, route], roleSets),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => entry.held.includes('ticket.read.masked'))).toBe(true);
    expect(sameAsRoute({ anyOf: [...wide.anyOf] }, { all: [...route.all] })).toBe(false);
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
    expect(
      leaksBeyondRoute({ text: 'A long message with space' }, route),
    ).toEqual([]);
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
