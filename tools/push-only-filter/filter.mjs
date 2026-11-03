// The push-only filter in front of a public tunnel (dev/POC only, docs/runbooks/local-poc.md §4).
// Forwards ONLY `POST /v1/inbound/gmail/push` that carries a bearer token to the api; everything else
// is answered here, so a public tunnel URL can never reach sign-in, admin or any other route.
// Plain Node, no dependencies.
import { createServer, request } from 'node:http';

export const PUSH_PATH = '/v1/inbound/gmail/push';
// A Gmail notification is a few hundred bytes; Pub/Sub's envelope keeps it well under this.
export const MAX_BODY_BYTES = 64 * 1024;
// Requests per minute per client before the token is even looked at. Pub/Sub pushes come from
// Google's addresses, so someone flooding the URL from elsewhere uses up only their own allowance,
// not the api's per-IP limit that every request through the tunnel would otherwise share.
export const PER_CLIENT_PER_MINUTE = 120;
// Only these request headers go to the api: no hop-by-hop, upgrade or forwarding headers.
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'user-agent'];
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Loopback on this machine, or the compose service `api` inside the gmail-tunnel container. */
export function assertUpstream(upstream) {
  if (!['127.0.0.1', 'localhost', '[::1]', 'api'].includes(upstream.hostname)) {
    throw new Error('PUSH_FILTER_UPSTREAM must be a loopback address or http://api:4000');
  }
}

/**
 * Who is calling, for the per-client allowance: behind cloudflared every socket is cloudflared's own,
 * so its `cf-connecting-ip` (set by the Cloudflare edge) names the caller; without it, the socket.
 */
export function clientOf(req) {
  const header = req.headers['cf-connecting-ip'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : (req.socket.remoteAddress ?? 'unknown');
}

/** A fixed one-minute window per client. */
export function createLimiter(limit, now = () => Date.now()) {
  const windows = new Map();
  return (client) => {
    const minute = Math.floor(now() / 60_000);
    const entry = windows.get(client);
    if (entry === undefined || entry.minute !== minute) {
      if (windows.size > 10_000) windows.clear();
      windows.set(client, { minute, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function createPushFilter({ upstream, log = () => {}, limit = PER_CLIENT_PER_MINUTE }) {
  assertUpstream(upstream);
  const allow = createLimiter(limit);
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const answer = (status, why) => {
      res.writeHead(status, { 'content-type': 'text/plain' }).end();
      // Method, path and status only: never a header, a body or a query string.
      log(`${why} ${String(req.method)} ${path.slice(0, 80)} -> ${String(status)}`);
      req.resume();
    };
    if (req.method !== 'POST' || path !== PUSH_PATH) return answer(404, 'blocked');
    if (!allow(clientOf(req))) return answer(429, 'limited');
    const authorization = req.headers.authorization;
    // Pub/Sub always signs its pushes; an unsigned request never reaches the api.
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) {
      return answer(401, 'unsigned');
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return answer(413, 'too large');

    const headers = { host: upstream.host };
    for (const name of FORWARDED_HEADERS) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const forward = request(
      {
        host: upstream.hostname.replace(/^\[|\]$/g, ''),
        port: upstream.port || 80,
        path: PUSH_PATH,
        method: 'POST',
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (reply) => {
        // Status and content type back; no other api header leaves through the tunnel.
        const contentType = reply.headers['content-type'];
        res.writeHead(reply.statusCode ?? 502, contentType ? { 'content-type': contentType } : {});
        reply.pipe(res);
        log(`push -> ${String(reply.statusCode)}`);
      },
    );
    forward.on('timeout', () => forward.destroy(new Error('timeout')));
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        forward.destroy(new Error('too large'));
        if (!res.headersSent) res.writeHead(413).end();
        req.destroy();
      }
    });
    req.pipe(forward);
  });
  // Slow clients do not hold a socket for long.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
