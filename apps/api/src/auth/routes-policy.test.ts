import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, WORKSPACE_ROLES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { FEATURE_PUBLIC_ROUTES } from '../public-routes.js';
import { collectRoutes } from '../testing/route-table.js';

// The whole point of a deny-by-default guard is that no route can be left unprotected by
// forgetting. This builds the real module graph (infrastructure faked, no network) and walks every
// route of every controller. A new route fails here until it says who may call it.

/** Every route that is open to anyone. Adding one is a decision; make it here, on purpose. */
const EXPECTED_PUBLIC_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'GET /metrics',
  'GET /v1/auth/config',
  'GET /v1/auth/google/start',
  'GET /v1/auth/google/callback',
  'POST /v1/auth/dev-login',
  'POST /v1/auth/magic-link/request',
  'POST /v1/auth/magic-link/verify',
  'POST /v1/auth/break-glass',
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  // The client portal (T-007): submit, track and answer without an account (ADR-007).
  'GET /v1/portal/challenge',
  'POST /v1/portal/tickets',
  'GET /v1/portal/tickets/:key',
  'POST /v1/portal/tickets/:key/replies',
  'POST /v1/portal/track/resend',
  // "Email me a link to my requests" (T-152): proof of work, one-time link, always 202.
  'POST /v1/portal/my-requests',
  'POST /v1/portal/my-requests/open',
  // Phase 1 feature modules list theirs in their own public-routes.ts (T-123a).
  ...FEATURE_PUBLIC_ROUTES,
].sort();

describe('every route states who may call it', () => {
  it('has a permission or @Public() on all of them', async () => {
    const routes = await collectRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(22);
    const unprotected = routes.filter(
      (route) => !route.isPublic && route.permissions.length === 0 && route.anyOf.length === 0,
    );
    expect(unprotected.map((route) => route.key)).toEqual([]);
    // The first test pays for importing every module of the api.
  }, 60_000);

  it('keeps the list of public routes to exactly the expected ones', async () => {
    const routes = await collectRoutes();
    expect(
      routes
        .filter((route) => route.isPublic)
        .map((route) => route.key)
        .sort(),
    ).toEqual(EXPECTED_PUBLIC_ROUTES);
  });

  it('never marks a route both public and permissioned', async () => {
    const routes = await collectRoutes();
    const both = routes.filter(
      (route) => route.isPublic && (route.permissions.length > 0 || route.anyOf.length > 0),
    );
    expect(both.map((route) => route.key)).toEqual([]);
  });

  it('only names permission strings that exist', async () => {
    const routes = await collectRoutes();
    for (const route of routes) {
      for (const permission of [...route.permissions, ...route.anyOf]) {
        expect(Object.hasOwn(PERMISSIONS, permission), `${route.key} uses ${permission}`).toBe(
          true,
        );
      }
    }
  });

  it('sees the routes this task added, so the walk is not vacuous', async () => {
    const keys = (await collectRoutes()).map((route) => route.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /health',
        'GET /v1/auth/session',
        'GET /v1/auth/sessions',
        'DELETE /v1/auth/sessions/:id',
        'GET /v1/users',
        'POST /v1/users',
        'PATCH /v1/users/:id',
        'POST /v1/users/:id/force-logout',
        'GET /v1/audit-logs',
        'GET /v1/rbac/roles',
        'PUT /v1/rbac/roles/:role/permissions',
        'GET /v1/orgs',
        'POST /v1/contacts',
        'POST /v1/queues',
        'POST /v1/intents',
        'POST /v1/sla-policies',
        'POST /v1/business-calendars',
        'PUT /v1/ticket-workflow',
        'GET /v1/tickets',
        'POST /v1/tickets',
        'GET /v1/tickets/:id',
        'PATCH /v1/tickets/:id',
        'POST /v1/tickets/:id/status',
        'POST /v1/tickets/:id/assign',
        'POST /v1/tickets/:id/merge',
        'POST /v1/tickets/:id/replies',
        'POST /v1/tickets/:id/notes',
        'GET /v1/tickets/:id/timeline',
        'GET /v1/tickets/:id/duplicates',
        'POST /v1/tickets/:id/portal-links/revoke',
        // Autonomy and the AI switches (T-112a).
        'GET /v1/autonomy',
        'POST /v1/autonomy/switches',
        'POST /v1/intents/:id/autonomy',
        // Head console (T-127).
        'GET /v1/tickets/stats',
        'GET /v1/intents/:id/autonomy/history',
        'PATCH /v1/business-calendars/:id/holidays/:date',
        'GET /v1/org-tiers',
        'GET /v1/audit-logs/export',
      ]),
    );
  });

  it('keeps head-only capabilities away from agent and lead permissions', async () => {
    const byKey = new Map((await collectRoutes()).map((route) => [route.key, route]));
    expect(byKey.get('GET /v1/audit-logs')?.permissions).toEqual(['audit.read']);
    expect(byKey.get('PUT /v1/rbac/roles/:role/permissions')?.permissions).toEqual(['rbac.manage']);
    expect(byKey.get('POST /v1/users/:id/force-logout')?.permissions).toEqual([
      'session.revoke.any',
    ]);
    expect(byKey.get('PATCH /v1/users/:id')?.permissions).toEqual(['user.manage']);
  });

  it('keeps ticket configuration and ticket handling behind their own permissions', async () => {
    const byKey = new Map((await collectRoutes()).map((route) => [route.key, route]));
    expect(byKey.get('PUT /v1/ticket-workflow')?.permissions).toEqual(['workflow.manage']);
    expect(byKey.get('POST /v1/sla-policies')?.permissions).toEqual(['sla.manage']);
    expect(byKey.get('POST /v1/business-calendars')?.permissions).toEqual(['sla.manage']);
    expect(byKey.get('POST /v1/queues')?.permissions).toEqual(['queue.manage']);
    expect(byKey.get('POST /v1/intents')?.permissions).toEqual(['intent.manage']);
    expect(byKey.get('POST /v1/orgs')?.permissions).toEqual(['org.manage']);
    // A client must never be able to write an internal note, merge, assign or change a status.
    for (const key of [
      'POST /v1/tickets/:id/merge',
      'POST /v1/tickets/:id/assign',
      'PATCH /v1/tickets/:id',
    ]) {
      expect(byKey.get(key)?.permissions, key).toEqual(['ticket.handle']);
    }
    // A note and a status change are also the developer's (T-137); the service holds a developer to
    // open and waiting_on_dev. A client has neither permission.
    for (const key of ['POST /v1/tickets/:id/notes', 'POST /v1/tickets/:id/status']) {
      expect(byKey.get(key)?.anyOf, key).toEqual(['ticket.handle', 'ticket.dev.work']);
    }
    // Revoking a customer's tracking links is staff work.
    expect(byKey.get('POST /v1/tickets/:id/portal-links/revoke')?.permissions).toEqual([
      'ticket.handle',
    ]);
    // Reading is open to both audiences; the service narrows to the caller's organization.
    expect(byKey.get('GET /v1/tickets')?.anyOf).toEqual([
      'ticket.read',
      'ticket.read.org',
      'ticket.read.masked',
    ]);
    expect(byKey.get('POST /v1/tickets/:id/replies')?.anyOf).toEqual([
      'ticket.reply',
      'ticket.reply.own',
    ]);
  });

  it('keeps the AI switches head-only and the stage change behind its own permission (T-112a)', async () => {
    const byKey = new Map((await collectRoutes()).map((route) => [route.key, route]));
    // ai.emergency_switch is also a lead permission; the head-only one is ai.autonomy.set.any.
    expect(byKey.get('POST /v1/autonomy/switches')?.permissions).toEqual([
      'ai.emergency_switch',
      'ai.autonomy.set.any',
    ]);
    expect(byKey.get('POST /v1/intents/:id/autonomy')?.permissions).toEqual(['ai.autonomy.set']);
    expect(byKey.get('GET /v1/autonomy')?.permissions).toEqual(['ticket.read']);
  });

  it('keeps the head console routes behind the right people (T-127)', async () => {
    const byKey = new Map((await collectRoutes()).map((route) => [route.key, route]));
    // Counts are staff work: a client holds `ticket.read.org`, not `ticket.read`.
    expect(byKey.get('GET /v1/tickets/stats')?.permissions).toEqual(['ticket.read']);
    expect(byKey.get('GET /v1/tickets/stats')?.anyOf).toEqual([]);
    // History is shown in the Intents admin page, which lead and head open.
    expect(byKey.get('GET /v1/intents/:id/autonomy/history')?.permissions).toEqual([
      'intent.manage',
    ]);
    // Marking a holiday checked is the head's (`sla.manage`), like the rest of the calendar.
    expect(byKey.get('PATCH /v1/business-calendars/:id/holidays/:date')?.permissions).toEqual([
      'sla.manage',
    ]);
    expect(byKey.get('GET /v1/org-tiers')?.permissions).toEqual(['ticket.read']);
    // Taking the audit log out needs both the audit permission and the export permission.
    expect(byKey.get('GET /v1/audit-logs/export')?.permissions).toEqual([
      'audit.read',
      'pii.export',
    ]);
  });

  // T-137: the developer reads with personal data masked. A route is open to them only by a permission
  // they hold, so this walks every route and lists the ones their permissions satisfy. Any other route
  // that appears here is a route nobody checked for masking: it fails until someone has.
  it('lets a developer reach only the routes that mask personal data (T-137)', async () => {
    const granted = new Set<string>(DEFAULT_ROLE_PERMISSIONS.dev);
    const reachable = (await collectRoutes())
      .filter((route) => !route.isPublic)
      .filter(
        (route) =>
          route.permissions.every((permission) => granted.has(permission)) &&
          (route.anyOf.length === 0 || route.anyOf.some((permission) => granted.has(permission))),
      )
      .map((route) => route.key);
    // The caller's own sessions: no ticket data.
    const own = reachable.filter((key) => key.includes(' /v1/auth/'));
    const rest = reachable.filter((key) => !key.includes(' /v1/auth/')).sort();
    expect(own.length).toBeGreaterThan(0);
    expect(rest).toEqual(
      [
        'GET /v1/tickets',
        'GET /v1/tickets/:id',
        'GET /v1/tickets/:id/duplicates',
        'GET /v1/tickets/:id/timeline',
        'GET /v1/tickets/:id/ai',
        'GET /v1/tickets/:id/ai/grade',
        // Whether the AI can be reached (T-170): the console banner, no ticket data.
        'GET /v1/ai/status',
        // The procedure of an intent (T-303b, `procedure.read`): internal text and steps, no ticket or customer data.
        'GET /v1/intents/:id/procedure/versions',
        'GET /v1/intents/:id/procedure/versions/:versionId',
        'GET /v1/intents/:id/procedure/versions/:versionId/validation',
        'GET /v1/intents/:id/procedure/versions/:versionId/simulation',
        'POST /v1/tickets/:id/notes',
        'POST /v1/tickets/:id/status',
        'POST /v1/tickets/:id/dev-owner',
        'DELETE /v1/tickets/:id/dev-owner',
        'POST /v1/tickets/:id/references',
        'DELETE /v1/tickets/:id/references/:linkId',
        'POST /v1/tickets/:id/ai/requests',
        // The saved investigation templates (T-203, `investigate.run`): a card is redacted before it is
        // stored (N4), so a developer gets what an agent gets. Reading the pinned cards (`ticket.read`)
        // and the unbounded queries (`investigate.adhoc`) are not theirs.
        'GET /v1/tools/templates',
        'GET /v1/tickets/:id/tools',
        'POST /v1/tickets/:id/tools/run',
        'POST /v1/incidents/:id/tools/run',
        'DELETE /v1/tickets/:id/evidence/:cardId',
        'DELETE /v1/incidents/:id/evidence/:cardId',
        // The AI assistant (T-134, ADR-023): the tools read through the masking of the ticket page, a card
        // shows the subject masked, a developer's status and note are the developer's own two moves, and the
        // free text the model writes is redacted before it is stored (tested in assistant.integration.test).
        'GET /v1/assistant/starters',
        'POST /v1/assistant/messages',
        'POST /v1/assistant/proposals/:id/confirm',
        'POST /v1/assistant/proposals/:id/reject',
        'DELETE /v1/assistant/conversations/:id',
        // Embedded insights (T-416, `assistant.use`): every element asks the rule of its own GET route, which a
        // developer does not hold for the wave 9a elements, and a masked view carries no customer (insights.integration.test).
        'GET /v1/insights',
      ].sort(),
    );
  });

  // T-401 / T-400 C-9: the assistant (and, later, the insights) are for the people who work in the workspace. The
  // refusal of a client and of a system identity is code (`@WorkspaceOnly()` in the guard), not a missing permission,
  // so granting `assistant.use` to either changes nothing; this test is an allowlist of what may be reachable.
  it('lets only workspace roles reach /v1/assistant/** and /v1/insights/** (allowlist)', async () => {
    const routes = (await collectRoutes()).filter((route) =>
      /^[A-Z]+ \/v1\/(assistant|insights)(\/|$)/.test(route.key),
    );
    expect(routes.length).toBeGreaterThan(0);
    // T-416: the insights route exists and is under the same allowlist (client, portal and magic-link sessions: 403).
    expect(routes.map((route) => route.key)).toContain('GET /v1/insights');
    for (const route of routes) {
      expect(route.isPublic, route.key).toBe(false);
      expect(route.workspaceOnly, route.key).toBe(true);
      const asked = [...route.permissions, ...route.anyOf];
      expect(asked.length, route.key).toBeGreaterThan(0);
      // Not even by a client-only permission.
      for (const permission of asked) {
        expect(/\.(org|own)$/.test(permission), `${route.key} ${permission}`).toBe(false);
      }
    }
    // The roles the guard lets through are exactly these; client and system are the rest.
    expect([...WORKSPACE_ROLES]).toEqual(['agent', 'lead', 'head', 'dev']);
    expect(ROLES.filter((role) => !(WORKSPACE_ROLES as readonly string[]).includes(role))).toEqual([
      'client',
      'system',
    ]);
    for (const role of ['client', 'system'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('assistant.use');
    }
    for (const role of WORKSPACE_ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('assistant.use');
    }
  });

  it('gives a developer nothing that reaches the customer', () => {
    const granted = new Set<string>(DEFAULT_ROLE_PERMISSIONS.dev);
    for (const permission of ['ticket.reply', 'ticket.handle', 'ai.draft.review', 'ticket.read']) {
      expect(granted.has(permission), permission).toBe(false);
    }
  });
});
