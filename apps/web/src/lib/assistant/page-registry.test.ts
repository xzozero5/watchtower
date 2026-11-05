import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ASSISTANT_PAGES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { matchRoute, PAGE_REGISTRY, resolveLocation, routeOfPageFile } from './page-registry';

const APP_DIR = join(process.cwd(), 'src', 'app');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const consoleRoutes = walk(join(APP_DIR, '(console)'))
  .filter((file) => file.endsWith('page.tsx'))
  .map((file) => routeOfPageFile(relative(APP_DIR, file)));

describe('page registry', () => {
  it('finds the console routes on disk (the walk itself works)', () => {
    expect(consoleRoutes.length).toBeGreaterThan(20);
    expect(consoleRoutes).toContain('/');
    expect(consoleRoutes).toContain('/admin/orgs/[id]');
  });

  it('has an entry for every route of the (console) group', () => {
    const registered = new Set(PAGE_REGISTRY.map((entry) => entry.route));
    const missing = consoleRoutes.filter((route) => !registered.has(route));
    expect(missing).toEqual([]);
  });

  it('has no entry for a route that no longer exists, and no duplicates', () => {
    const routes = PAGE_REGISTRY.map((entry) => entry.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.filter((route) => !consoleRoutes.includes(route))).toEqual([]);
  });

  it('only names page kinds the api knows', () => {
    for (const entry of PAGE_REGISTRY) {
      expect(ASSISTANT_PAGES).toContain(entry.page);
    }
  });

  it('has nothing for the public routes, and their files never import the assistant', () => {
    const publicRoots = ['portal', 'status', 'csat', 'start', 'login'];
    for (const root of publicRoots) {
      expect(matchRoute(`/${root}`)).toBeNull();
    }
    for (const entry of PAGE_REGISTRY) {
      expect(
        publicRoots.some(
          (root) => entry.route === `/${root}` || entry.route.startsWith(`/${root}/`),
        ),
      ).toBe(false);
    }
    const files = walk(APP_DIR).filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        publicRoots.some((root) =>
          relative(APP_DIR, file).replace(/\\/g, '/').startsWith(`${root}/`),
        ),
    );
    // page.tsx and layout.tsx of every public root, plus the page files that sit directly under `app`.
    for (const file of [...files, join(APP_DIR, 'start', 'page.tsx')]) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(APP_DIR, file)).not.toMatch(/from\s+['"][^'"]*assistant/i);
    }
    const publicLayouts = ['portal', 'status', 'csat'].map((root) =>
      join(APP_DIR, root, 'layout.tsx'),
    );
    for (const layout of publicLayouts) {
      expect(readFileSync(layout, 'utf8')).not.toMatch(/assistant/i);
    }
  });

  it('reads the open entity from the address or the params', () => {
    expect(resolveLocation('/', '')).toEqual({ page: 'queue', entity: null });
    expect(resolveLocation('/', '?ticket=OPS-12')).toEqual({
      page: 'ticket',
      entity: { kind: 'ticket', ref: 'OPS-12' },
    });
    expect(resolveLocation('/', '?ticket=not a ticket!').entity).toBeNull();
    expect(resolveLocation('/incidents', '?incident=abc-1')).toEqual({
      page: 'incident',
      entity: { kind: 'incident', ref: 'abc-1' },
    });
    expect(resolveLocation('/alerts', '?alert=a1').entity).toEqual({ kind: 'alert', ref: 'a1' });
    expect(resolveLocation('/admin/intents/i-7', '').entity).toEqual({
      kind: 'intent',
      ref: 'i-7',
    });
    expect(resolveLocation('/admin/orgs/o-9', '')).toEqual({
      page: 'admin',
      entity: { kind: 'org', ref: 'o-9' },
    });
    expect(resolveLocation('/shift/brief', '').page).toBe('brief');
    expect(resolveLocation('/shift/handoff', '').page).toBe('handoff');
    expect(resolveLocation('/admin/shifts', '').page).toBe('roster');
  });

  it('drops an entity ref the contract would refuse, and falls back to "other" for an unknown address', () => {
    expect(resolveLocation('/incidents', '?incident=' + 'x'.repeat(80)).entity).toBeNull();
    expect(resolveLocation('/incidents', '?incident=a%20b').entity).toBeNull();
    expect(resolveLocation('/no/such/page', '')).toEqual({ page: 'other', entity: null });
  });
});
