/* Watchtower service worker (T-006): the minimum a PWA needs, and nothing that can leak data.
 *
 *  - It only ever handles same-origin GET requests. The API (another origin, cookies, personal
 *    data) and every other host pass straight through, so nothing a customer or a ticket contains
 *    is stored by this file.
 *  - Navigations go to the network; if the network is down the cached /offline.html is shown.
 *    Page HTML is never cached: it depends on who is signed in.
 *  - Build output under /_next/static/ is content-hashed, so it is cached first and for good.
 *    The logo files are refreshed in the background.
 *  - The public client portal and the CSAT survey page are never touched: /portal and /csat
 *    pages (HTML and the data requests behind them) and /v1/ api paths on this origin pass straight through, so a tracking page, a ticket
 *    number or a reply is never stored here and never answered from a cache (T-007).
 *  - Web Push (T-105): a `push` event always shows one notification (browsers require it) built only from the
 *    message's `kind`/`severity`, never from free text, and a click opens a path on this origin only. The
 *    message holds no customer text; the app fetches the details once it is open. No background sync, no
 *    calls to any host of its own.
 */
/* global self, caches */
const CACHE = 'wt-static-v1';
const OFFLINE_URL = '/offline.html';
// Paths this worker must never handle, cache or answer. A path matches itself and everything below.
const NEVER_HANDLE = ['/portal', '/csat', '/status', '/v1'];

function neverHandle(pathname) {
  return NEVER_HANDLE.some((base) => pathname === base || pathname.startsWith(base + '/'));
}

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
  if (neverHandle(url.pathname)) return;

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

// --- Web Push (T-105) ---
// What a message may say. The words are ours, picked by `kind`; nothing from the message is shown as text.
const PUSH_TEXT = {
  'ticket.p1': ['A P1 ticket needs attention', 'มีตั๋ว P1 ที่ต้องดูด่วน'],
  'ticket.assigned': ['A ticket was assigned to you', 'มีตั๋วมอบหมายให้คุณ'],
  'shift.handoff_overdue': [
    'Handoff items were not acknowledged',
    'รายการส่งต่องานยังไม่มีคนรับทราบ',
  ],
  'shift.no_show': ['Someone has not clocked in', 'มีคนยังไม่ลงเวลาเข้ากะ'],
  'alert.fired': ['An alert needs you', 'มี alert ที่ต้องการคุณ'],
  'alert.escalated': ['An alert was not acknowledged', 'มี alert ที่ยังไม่มีคนรับทราบ'],
};
const PUSH_FALLBACK = ['Something needs you', 'มีเรื่องที่ต้องดู'];

function pushLanguageIndex() {
  const language = (self.navigator && self.navigator.language) || 'en';
  return language.toLowerCase().startsWith('th') ? 1 : 0;
}

/** A path on this origin, or '/'. Anything else (another host, `//host`, `javascript:`) becomes '/'. */
function safeTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let message;
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  if (message === null || typeof message !== 'object') message = {};
  const text = Object.prototype.hasOwnProperty.call(PUSH_TEXT, message.kind)
    ? PUSH_TEXT[message.kind]
    : PUSH_FALLBACK;
  const critical = message.severity === 'critical';
  // A push must always show a notification (userVisibleOnly), even when the message could not be read.
  event.waitUntil(
    self.registration.showNotification('Watchtower', {
      body: text[pushLanguageIndex()],
      icon: '/brand/watchtower-icon.png',
      // The same notification id replaces the earlier banner instead of stacking.
      tag:
        typeof message.notificationId === 'string'
          ? message.notificationId.slice(0, 64)
          : 'watchtower',
      requireInteraction: critical,
      data: { url: safeTarget(message.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    safeTarget(event.notification.data && event.notification.data.url),
    self.location.origin,
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        return open
          .focus()
          .then(() => open.navigate(target.href))
          .catch(() => self.clients.openWindow(target.href));
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
