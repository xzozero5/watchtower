// Local filter in front of a public tunnel (dev/POC only, see docs/runbooks/local-poc.md §4): the
// rules are in ./filter.mjs. Runs on this machine (`pnpm push-filter`) or inside the gmail-tunnel
// container (tools/gmail-tunnel, ADR-020).
//
//   node tools/push-only-filter/server.mjs        # listens on 127.0.0.1:4318, forwards to 127.0.0.1:4000
//   PUSH_FILTER_PORT=4318 PUSH_FILTER_UPSTREAM=http://127.0.0.1:4000 node tools/push-only-filter/server.mjs
import { createPushFilter } from './filter.mjs';

const port = Number(process.env.PUSH_FILTER_PORT ?? 4318);
const upstream = new URL(process.env.PUSH_FILTER_UPSTREAM ?? 'http://127.0.0.1:4000');
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

let server;
try {
  server = createPushFilter({ upstream, log });
} catch (error) {
  console.error(`push-only-filter: ${error instanceof Error ? error.message : 'invalid settings'}`);
  process.exit(1);
}
server.listen(port, '127.0.0.1', () => {
  log(
    `push-only-filter on 127.0.0.1:${String(port)} -> ${upstream.origin} (signed POST ${'/v1/inbound/gmail/push'} only)`,
  );
});
