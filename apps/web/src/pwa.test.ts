import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { COLOR_TOKENS } from '@watchtower/ui';
import { describe, expect, it, vi } from 'vitest';

import { th } from '@/i18n/messages/th';

const cookieValue = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'wt-locale' && cookieValue.locale ? { value: cookieValue.locale } : undefined,
    }),
  headers: () => Promise.resolve({ get: () => null }),
}));

const publicDir = join(import.meta.dirname, '..', 'public');
const workerSource = readFileSync(join(publicDir, 'sw.js'), 'utf8');

describe('web app manifest', () => {
  it('describes an installable app that opens on the queue', async () => {
    const { default: manifest } = await import('./app/manifest');
    const result = await manifest();
    expect(result).toMatchObject({
      name: 'Watchtower',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
    });
    // At least one icon of 512 px, the size installers require, and every icon file exists.
    expect(result.icons?.some((icon) => icon.sizes === '512x512')).toBe(true);
    for (const icon of result.icons ?? []) {
      expect(existsSync(join(publicDir, icon.src)), icon.src).toBe(true);
    }
  });

  it('takes its colours from the design tokens, not from literals', async () => {
    const { default: manifest } = await import('./app/manifest');
    const result = await manifest();
    expect(result.background_color).toBe(COLOR_TOKENS.light.background);
    expect(result.theme_color).toBe(COLOR_TOKENS.light.primary);
    const source = readFileSync(join(import.meta.dirname, 'app', 'manifest.ts'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('follows the visitor language', async () => {
    cookieValue.locale = 'th';
    const { default: manifest } = await import('./app/manifest');
    const result = await manifest();
    expect(result.lang).toBe('th');
    expect(result.description).toBe(th.app.description);
    cookieValue.locale = undefined;
  });
});

/** Loads sw.js in a fake worker scope and returns the handlers it registered. */
function loadWorker(options: { origin?: string; caches: unknown; fetch: unknown }) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    location: { origin: options.origin ?? 'https://app.test' },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: { claim: vi.fn(() => Promise.resolve()) },
  };
  runInNewContext(workerSource, {
    self,
    caches: options.caches,
    fetch: options.fetch,
    Response,
    URL,
  });
  return { listeners, self };
}

function fakeCaches(initial: Record<string, Map<string, Response>> = {}) {
  const stores = new Map(Object.entries(initial));
  const open = (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return Promise.resolve({
      add: (url: string) => {
        store.set(url, new Response('offline page'));
        return Promise.resolve();
      },
      put: (request: Request | string, response: Response) => {
        store.set(typeof request === 'string' ? request : request.url, response);
        return Promise.resolve();
      },
      match: (request: Request | string) =>
        Promise.resolve(store.get(typeof request === 'string' ? request : request.url)),
    });
  };
  return {
    stores,
    open,
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
    match: (request: Request | string) => {
      for (const store of stores.values()) {
        const hit = store.get(typeof request === 'string' ? request : request.url);
        if (hit) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
  };
}

interface FetchEventLike {
  request: Request;
  respondWith: ReturnType<typeof vi.fn>;
}

const fetchEvent = (url: string, init?: RequestInit, mode?: string): FetchEventLike => {
  const request = new Request(url, init);
  if (mode) Object.defineProperty(request, 'mode', { value: mode });
  return { request, respondWith: vi.fn() };
};

describe('service worker', () => {
  it('registers only install, activate and fetch: no push, no background sync', () => {
    const { listeners } = loadWorker({ caches: fakeCaches(), fetch: vi.fn() });
    expect(Object.keys(listeners).sort()).toEqual(['activate', 'fetch', 'install']);
  });

  it('contains no absolute URL, so it can never call a host of its own', () => {
    expect(workerSource).not.toMatch(/https?:\/\//);
    expect(workerSource).not.toMatch(/\bimportScripts\b/);
    expect(workerSource).not.toMatch(/\bpush\b.*addEventListener|addEventListener\(\s*'push'/);
  });

  it('caches the offline page on install and removes old caches on activate', async () => {
    const caches = fakeCaches({ 'wt-static-v0': new Map() });
    const { listeners, self } = loadWorker({ caches, fetch: vi.fn() });

    let pending: Promise<unknown> = Promise.resolve();
    listeners.install?.({ waitUntil: (promise: Promise<unknown>) => (pending = promise) });
    await pending;
    expect(caches.stores.get('wt-static-v1')?.has('/offline.html')).toBe(true);
    expect(self.skipWaiting).toHaveBeenCalled();

    listeners.activate?.({ waitUntil: (promise: Promise<unknown>) => (pending = promise) });
    await pending;
    expect([...caches.stores.keys()]).toEqual(['wt-static-v1']);
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it('leaves other origins alone (the API, the sign-in provider, anything)', () => {
    const fetchSpy = vi.fn();
    const { listeners } = loadWorker({ caches: fakeCaches(), fetch: fetchSpy });
    for (const url of [
      'https://api.example.com/v1/tickets',
      'http://localhost:4000/v1/auth/session',
    ]) {
      const event = fetchEvent(url);
      listeners.fetch?.(event);
      expect(event.respondWith, url).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves writes alone', () => {
    const { listeners } = loadWorker({ caches: fakeCaches(), fetch: vi.fn() });
    const event = fetchEvent('https://app.test/anything', { method: 'POST', body: '{}' });
    listeners.fetch?.(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('shows the offline page when a navigation cannot reach the network, and never caches pages', async () => {
    const caches = fakeCaches({
      'wt-static-v1': new Map([['/offline.html', new Response('offline page')]]),
    });
    const failing = vi.fn(() => Promise.reject(new TypeError('offline')));
    const { listeners } = loadWorker({ caches, fetch: failing });
    const event = fetchEvent('https://app.test/', undefined, 'navigate');
    listeners.fetch?.(event);
    const response = (await event.respondWith.mock.calls[0]?.[0]) as Response;
    expect(await response.text()).toBe('offline page');

    // When the network works, the page comes from the network and nothing is stored.
    const online = vi.fn(() => Promise.resolve(new Response('live page')));
    const second = loadWorker({ caches, fetch: online });
    const liveEvent = fetchEvent('https://app.test/?ticket=OPS-1', undefined, 'navigate');
    second.listeners.fetch?.(liveEvent);
    const live = (await liveEvent.respondWith.mock.calls[0]?.[0]) as Response;
    expect(await live.text()).toBe('live page');
    expect([...(caches.stores.get('wt-static-v1')?.keys() ?? [])]).toEqual(['/offline.html']);
  });

  it('never touches the public portal: its pages and any same-origin api path pass through', () => {
    const fetchSpy = vi.fn();
    const caches = fakeCaches();
    const { listeners } = loadWorker({ caches, fetch: fetchSpy });
    const cases: [string, string | undefined][] = [
      ['https://app.test/portal', 'navigate'],
      ['https://app.test/portal/submitted', 'navigate'],
      ['https://app.test/portal/tickets/OPS-12', 'navigate'],
      ['https://app.test/portal/tickets/OPS-12?_rsc=abc', undefined],
      ['https://app.test/v1/portal/challenge', undefined],
      ['https://app.test/v1/portal/tickets/OPS-12', undefined],
    ];
    for (const [url, mode] of cases) {
      const event = fetchEvent(url, undefined, mode);
      listeners.fetch?.(event);
      expect(event.respondWith, url).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(caches.stores.size).toBe(0);
  });

  it('does not mistake a path that only starts with the same letters for the portal', () => {
    const online = vi.fn(() => Promise.resolve(new Response('live page')));
    const { listeners } = loadWorker({ caches: fakeCaches(), fetch: online });
    const event = fetchEvent('https://app.test/portals-are-not-special', undefined, 'navigate');
    listeners.fetch?.(event);
    expect(event.respondWith).toHaveBeenCalled();
  });

  it('serves build assets from the cache first', async () => {
    const url = 'https://app.test/_next/static/chunks/app.js';
    const cached = new Response('cached script');
    const caches = fakeCaches({ 'wt-static-v1': new Map([[url, cached]]) });
    const network = vi.fn(() => Promise.resolve(new Response('from network')));
    const { listeners } = loadWorker({ caches, fetch: network });
    const event = fetchEvent(url);
    listeners.fetch?.(event);
    const response = (await event.respondWith.mock.calls[0]?.[0]) as Response;
    expect(await response.text()).toBe('cached script');
    expect(network).not.toHaveBeenCalled();
  });
});
