/* Watchtower service worker (T-006): the minimum a PWA needs, and nothing that can leak data.
 *
 *  - It only ever handles same-origin GET requests. The API (another origin, cookies, personal
 *    data) and every other host pass straight through, so nothing a customer or a ticket contains
 *    is stored by this file.
 *  - Navigations go to the network; if the network is down the cached /offline.html is shown.
 *    Page HTML is never cached: it depends on who is signed in.
 *  - Build output under /_next/static/ is content-hashed, so it is cached first and for good.
 *    The logo files are refreshed in the background.
 *  - No push, no background sync, no calls to any host of its own.
 */
/* global self, caches */
const CACHE = 'wt-static-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(OFFLINE_URL)
          .then((cached) => cached || new Response('Offline', { status: 503 })),
      ),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (url.pathname.startsWith('/brand/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const refresh = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          return cached || refresh;
        }),
      ),
    );
  }
});
