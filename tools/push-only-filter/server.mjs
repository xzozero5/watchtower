// Local filter in front of a public tunnel (dev/POC only, see docs/runbooks/local-poc.md).
// Forwards ONLY `POST /v1/inbound/gmail/push` to the api; every other path answers 404, so a public
// tunnel URL can never reach sign-in, admin or any other route. Plain Node, no dependencies.
//
//   node tools/push-only-filter/server.mjs        # listens on 127.0.0.1:4318, forwards to 127.0.0.1:4000
//   PUSH_FILTER_PORT=4318 PUSH_FILTER_UPSTREAM=http://127.0.0.1:4000 node tools/push-only-filter/server.mjs
import { createServer, request } from 'node:http';

const port = Number(process.env.PUSH_FILTER_PORT ?? 4318);
const upstream = new URL(process.env.PUSH_FILTER_UPSTREAM ?? 'http://127.0.0.1:4000');
const ALLOWED = new Set(['/v1/inbound/gmail/push']);

if (!['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) {
  console.error('push-only-filter: PUSH_FILTER_UPSTREAM must be a loopback address');
  process.exit(1);
}

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || !ALLOWED.has(path)) {
    res.writeHead(404).end();
    // Method and path only: never a header, a body or a query string.
    console.log(`${new Date().toISOString()} blocked ${req.method} ${path.slice(0, 80)}`);
    return;
  }
  const forward = request(
    {
      host: upstream.hostname.replace(/^\[|\]$/g, ''),
      port: upstream.port || 80,
      path: req.url,
      method: 'POST',
      headers: { ...req.headers, host: upstream.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      console.log(`${new Date().toISOString()} push -> ${String(answer.statusCode)}`);
    },
  );
  forward.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(forward);
}).listen(port, '127.0.0.1', () => {
  console.log(
    `push-only-filter on 127.0.0.1:${String(port)} -> ${upstream.origin} (POST /v1/inbound/gmail/push only)`,
  );
});
