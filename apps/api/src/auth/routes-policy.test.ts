import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PERMISSIONS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import { DATABASE } from '../database/database.module.js';
import { createLogger } from '../logging/logger.js';
import { FEATURE_PUBLIC_ROUTES } from '../public-routes.js';
import { REDIS } from '../redis/redis.module.js';
import { testConfig } from '../testing/support.js';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, PUBLIC_KEY } from './decorators.js';

// The whole point of a deny-by-default guard is that no route can be left unprotected by
// forgetting. This builds the real module graph (infrastructure faked, no network) and walks every
// route of every controller. A new route fails here until it says who may call it.

interface RouteInfo {
  readonly key: string;
  readonly controller: string;
  readonly method: string;
  readonly isPublic: boolean;
  readonly permissions: readonly string[];
  readonly anyOf: readonly string[];
  readonly unsafe: boolean;
}

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

async function collectRoutes(): Promise<RouteInfo[]> {
  const config = testConfig();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config, createLogger(config))],
  })
    .overrideProvider(DATABASE)
    .useValue({ db: {}, pool: {}, ping: () => Promise.resolve(), close: () => Promise.resolve() })
    .overrideProvider(REDIS)
    .useValue({
      ping: () => Promise.resolve('PONG'),
      quit: () => Promise.resolve('OK'),
      disconnect: () => undefined,
    })
    .compile();

  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const routes: RouteInfo[] = [];
  for (const module of moduleRef.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (!controller) continue;
      const prefix = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
      for (const name of scanner.getAllMethodNames(controller.prototype as object)) {
        const handler = (controller.prototype as Record<string, unknown>)[name] as Type;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (path === undefined || verb === undefined) continue;
        const method = METHODS[verb] ?? String(verb);
        const targets = [handler, controller];
        routes.push({
          key: `${method} /${[prefix, path]
            .join('/')
            .replace(/\/+/g, '/')
            .replace(/^\/|\/$/g, '')}`,
          controller: controller.name,
          method,
          isPublic: reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true,
          permissions:
            reflector.getAllAndOverride<readonly string[] | undefined>(PERMISSIONS_KEY, targets) ??
            [],
          anyOf:
            reflector.getAllAndOverride<readonly string[] | undefined>(
              ANY_PERMISSIONS_KEY,
              targets,
            ) ?? [],
          unsafe: !['GET', 'HEAD', 'OPTIONS'].includes(method),
        });
      }
    }
  }
  await moduleRef.close();
  return routes;
}

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
  });

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
      'POST /v1/tickets/:id/notes',
      'POST /v1/tickets/:id/merge',
      'POST /v1/tickets/:id/assign',
      'POST /v1/tickets/:id/status',
      'PATCH /v1/tickets/:id',
    ]) {
      expect(byKey.get(key)?.permissions, key).toEqual(['ticket.handle']);
    }
    // Revoking a customer's tracking links is staff work.
    expect(byKey.get('POST /v1/tickets/:id/portal-links/revoke')?.permissions).toEqual([
      'ticket.handle',
    ]);
    // Reading is open to both audiences; the service narrows to the caller's organization.
    expect(byKey.get('GET /v1/tickets')?.anyOf).toEqual(['ticket.read', 'ticket.read.org']);
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
});
