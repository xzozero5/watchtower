// Entry point of the gmail-tunnel container (ADR-020, dev/POC only). It runs, in one container:
//   1. the push-only filter (tools/push-only-filter) in front of the api: POST /v1/inbound/gmail/push only
//   2. a Cloudflare quick tunnel to that filter (random https://<words>.trycloudflare.com, new on every start)
//   3. Pub/Sub `modifyPushConfig` so the Gmail push subscription delivers to the new URL
// and stays up while both children run. If either exits, the container exits and compose restarts it
// (a new URL, subscribed again). Never logs a token, a key or a request body.
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import {
  fetchAccessToken,
  modifyPushConfig,
  parseServiceAccountKey,
  parseTunnelUrl,
  readSettings,
  selfCheck,
  waitForTunnel,
} from './tunnel.mjs';

const KEY_PATH = process.env.GMAIL_TUNNEL_KEY_FILE ?? '/secrets/pubsub-admin.json';
const FILTER_PORT = 4318;
const HEALTH_PORT = 4319;
const log = (message) => console.log(`${new Date().toISOString()} gmail-tunnel: ${message}`);

const children = [];
function stopAll(code) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
function fail(message) {
  log(message);
  stopAll(1);
}

let settings;
let key;
try {
  settings = readSettings(process.env);
  if (!statSync(KEY_PATH).isFile())
    throw new Error('GMAIL_TUNNEL_SA_KEY_PATH is not set (no key file mounted)');
  key = parseServiceAccountKey(readFileSync(KEY_PATH, 'utf8'));
} catch (error) {
  fail(error instanceof Error ? error.message : 'invalid settings');
}

let subscribed = false;
createServer((req, res) => {
  // Only "subscribed" or not: no URL, no project, nothing else.
  res.writeHead(subscribed ? 200 : 503).end(subscribed ? 'ok' : 'starting');
}).listen(HEALTH_PORT, '127.0.0.1');

process.on('SIGTERM', () => stopAll(0));
process.on('SIGINT', () => stopAll(0));

const filter = spawn(process.execPath, ['/app/push-only-filter/server.mjs'], {
  env: {
    PATH: process.env.PATH,
    PUSH_FILTER_PORT: String(FILTER_PORT),
    PUSH_FILTER_UPSTREAM: process.env.PUSH_FILTER_UPSTREAM ?? 'http://api:4000',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(filter);

// Quick tunnel: no account, no credential. Its log goes to stderr; we read it for the URL only.
const tunnel = spawn(
  'cloudflared',
  ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${String(FILTER_PORT)}`],
  { env: { PATH: process.env.PATH, HOME: '/tmp' }, stdio: ['ignore', 'ignore', 'pipe'] },
);
children.push(tunnel);

for (const child of [filter, tunnel]) {
  child.on('exit', (code) => {
    log(`${child === filter ? 'filter' : 'cloudflared'} exited (${String(code)}); stopping`);
    stopAll(1);
  });
}

let url = null;
createInterface({ input: tunnel.stderr }).on('line', (line) => {
  if (url !== null) return;
  const found = parseTunnelUrl(line);
  if (found === null) return;
  url = found;
  void subscribe(found);
});

setTimeout(() => {
  if (url === null) fail('cloudflared printed no tunnel URL within 60 s');
}, 60_000).unref();

async function subscribe(tunnelUrl) {
  log(`tunnel ${tunnelUrl}`);
  if (!(await waitForTunnel(fetch, tunnelUrl))) fail('the tunnel did not answer within 60 s');
  try {
    const token = await fetchAccessToken(fetch, key, Math.floor(Date.now() / 1000));
    await modifyPushConfig(fetch, token, tunnelUrl, settings);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'subscribing failed');
  }
  subscribed = true;
  log(`subscription ${settings.subscription} now pushes to ${tunnelUrl}/v1/inbound/gmail/push`);
  const status = await selfCheck(fetch, tunnelUrl).catch(() => 0);
  if (status === 401)
    log(
      'self-check: a push with a made-up token reaches the api and is refused (401), as it should be',
    );
  else if (status === 503)
    log(
      'self-check: the api answered 503 — GMAIL_PUSH_AUDIENCE / GMAIL_PUSH_SERVICE_ACCOUNT not set on the api',
    );
  else log(`self-check: unexpected HTTP ${String(status)} for the self-check push`);
}
