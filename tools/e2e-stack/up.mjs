// Brings up a throwaway Watchtower stack from source for the full-stack e2e (T-009):
//   - a fresh Postgres database on the compose server (migrated, app role created, demo-seeded),
//   - apps/api, apps/worker and the apps/web standalone build on non-default loopback ports,
//   - Redis keys of their own (database index + BullMQ prefix) and the compose Mailpit for email.
// Nothing leaves 127.0.0.1. Secrets (JWT, encryption key, break-glass password) are generated here
// and written to a 0600 state file for the test process; they are never printed.
//
//   node tools/e2e-stack/up.mjs --state <file>
//
// It prints "READY <state file>" when everything answers and then runs until SIGTERM/SIGINT or until
// its stdin closes (the Playwright process died). Stopping drops the database. Needs a build first:
//   pnpm turbo run build   (api, worker, db, shared and the web standalone output)
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const env = process.env;

const stateIndex = process.argv.indexOf('--state');
const stateFile = stateIndex === -1 ? undefined : process.argv[stateIndex + 1];
if (!stateFile) {
  console.error('usage: node tools/e2e-stack/up.mjs --state <file>');
  process.exit(2);
}

const WEB_PORT = Number(env.E2E_WEB_PORT ?? 3310);
const API_PORT = Number(env.E2E_API_PORT ?? 4310);
const WORKER_PORT = Number(env.E2E_WORKER_PORT ?? 4410);
const ADMIN_URL =
  env.E2E_ADMIN_DATABASE_URL ??
  env.TEST_DATABASE_URL ??
  'postgres://watchtower:watchtower@localhost:5432/watchtower';
// A Redis database index of its own keeps rate-limit counters apart from a dev stack on index 0.
const REDIS_URL = env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/9';
const MAILPIT_URL = (env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/, '');
const SMTP_HOST = env.E2E_SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = env.E2E_SMTP_PORT ?? '1025';

const webUrl = `http://127.0.0.1:${String(WEB_PORT)}`;
const apiUrl = `http://127.0.0.1:${String(API_PORT)}`;
const runId = randomBytes(4).toString('hex');
const logDir = mkdtempSync(join(tmpdir(), 'wt-e2e-stack-'));
const children = [];
let database;
let stopping = false;

const log = (message) => {
  console.log(`[e2e-stack] ${message}`);
};

async function waitFor(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'error';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become healthy at ${url} (${last}); logs in ${logDir}`);
}

function start(name, args, childEnv) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = createWriteStream(join(logDir, `${name}.log`));
  child.stdout.pipe(sink, { end: false });
  child.stderr.pipe(sink, { end: false });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[e2e-stack] ${name} exited unexpectedly (${String(code ?? signal)}); see ${logDir}`,
      );
      void stop(1);
    }
  });
  children.push({ name, child });
  return child;
}

function run(name, args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed (${String(code)}): ${output.slice(-1500)}`));
    });
  });
}

async function clearRateLimits() {
  // Counters from earlier runs on this Redis index (the api keeps them for up to an hour).
  const require = createRequire(join(root, 'apps', 'api', 'package.json'));
  const mod = require('ioredis');
  const Redis = mod.default ?? mod.Redis ?? mod;
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'wt:rl:*', 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && children.some(({ child }) => child.exitCode === null)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
  try {
    await database?.cleanup();
  } catch (error) {
    console.error(
      `[e2e-stack] could not drop the database: ${error instanceof Error ? error.message : 'error'}`,
    );
  }
  // Logs are kept after a failed start, or when E2E_KEEP_LOGS=1; otherwise the temp dir goes.
  if (code === 0 && env.E2E_KEEP_LOGS !== '1') rmSync(logDir, { recursive: true, force: true });
  process.exit(code);
}

process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
// The parent (Playwright) holds our stdin; when it goes away, tear down so nothing is left running.
process.stdin.on('end', () => void stop(0));
process.stdin.on('error', () => void stop(0));
process.stdin.resume();

async function main() {
  for (const required of [
    'apps/api/dist/main.js',
    'apps/worker/dist/main.js',
    'apps/web/.next/standalone/apps/web/server.js',
    'packages/db/dist/testing.js',
  ]) {
    if (!existsSync(join(root, required))) {
      throw new Error(`${required} is missing. Run \`pnpm turbo run build\` first.`);
    }
  }
  await fetch(`${MAILPIT_URL}/api/v1/info`, { signal: AbortSignal.timeout(3000) }).catch(() => {
    throw new Error(`Mailpit is not reachable at ${MAILPIT_URL} (docker compose up -d mailpit)`);
  });

  const { createTestDatabase } = await import(
    pathToFileURL(join(root, 'packages', 'db', 'dist', 'testing.js')).href
  );
  database = await createTestDatabase(ADMIN_URL);
  log(`database ${database.name} created`);

  const base = {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? tmpdir(),
    TMPDIR: env.TMPDIR ?? tmpdir(),
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  await run('seed', [join(root, 'packages', 'db', 'dist', 'seed-cli.js')], {
    ...base,
    MIGRATION_DATABASE_URL: database.ownerUrl,
    TICKET_KEY_PREFIX: 'OPS',
  });
  log('demo data seeded');
  await clearRateLimits();

  const breakGlassEmail = `e2e-admin-${runId}@example.com`;
  const breakGlassPassword = randomBytes(18).toString('base64url');
  // Secrets of the mock integrations, made here so the test process and the api share them (never printed):
  // the LINE channel secret that signs webhooks, the machine-alert HMAC secret and the Discord application's
  // Ed25519 key pair (the api gets the public half; the tests sign interactions with the private half).
  const lineChannelSecret = randomBytes(24).toString('base64');
  const alertWebhookSecret = randomBytes(24).toString('base64url');
  const discordKeys = generateKeyPairSync('ed25519');
  const discordPublicKeyHex = discordKeys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const discordPrivateKeyPem = discordKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const netLog = join(logDir, 'network-attempts.jsonl');
  const lineLog = join(logDir, 'line-calls.jsonl');
  writeFileSync(netLog, '');
  writeFileSync(lineLog, '');
  // Every stack process loads the guard that refuses any connection that is not loopback (T-113).
  const guard = join(import.meta.dirname, 'no-network.cjs');
  const guarded = { NODE_OPTIONS: `--require=${guard}`, E2E_NET_LOG: netLog };
  const shared = {
    ...base,
    LOG_LEVEL: env.E2E_LOG_LEVEL ?? 'warn',
    HOST: '127.0.0.1',
    APP_URL: webUrl,
    API_URL: apiUrl,
    DATABASE_URL: database.appUrl,
    REDIS_URL,
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'watchtower',
    S3_ACCESS_KEY: 'e2e-not-used',
    S3_SECRET_KEY: 'e2e-not-used-secret',
    JWT_SECRET: randomBytes(32).toString('base64'),
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SMTP_HOST,
    SMTP_PORT,
    E2E_QUEUE_PREFIX: `wt-e2e-${runId}`,
    OUTBOX_POLL_INTERVAL_MS: '250',
    // The stack has no Gmail credential: the in-memory mailbox is an explicit opt-in (T-102).
    GMAIL_MOCK_ENABLED: 'true',
    // Mock integrations the T-113 scenarios drive: the LINE channel secret (the transport is the stack's
    // in-memory one, see line-transport.mjs), the machine-alert secret, Discord's public key, the tools'
    // fixtures instead of GCP and a product database, and the AI/embedding mocks (the defaults, said out loud).
    LINE_CHANNEL_SECRET: lineChannelSecret,
    ALERT_WEBHOOK_SECRET: alertWebhookSecret,
    DISCORD_PUBLIC_KEY: discordPublicKeyHex,
    DISCORD_APPLICATION_ID: '100000000000000001',
    AI_PROVIDER: 'mock',
    EMBEDDING_PROVIDER: 'mock',
    AI_TOOL_FIXTURES_DIR: join(root, 'examples', 'tools'),
    AI_TOOLS_WITHOUT_READONLY_LOGIN: 'true',
    ...guarded,
  };
  start('worker', [join(import.meta.dirname, 'worker-runner.mjs')], {
    ...shared,
    WORKER_PORT: String(WORKER_PORT),
    E2E_LINE_LOG: lineLog,
  });
  start('api', [join(import.meta.dirname, 'api-runner.mjs')], {
    ...shared,
    API_PORT: String(API_PORT),
    BREAK_GLASS_EMAIL: breakGlassEmail,
    BREAK_GLASS_PASSWORD: breakGlassPassword,
    // Sign-in as an agent, a lead or a developer: the mock identity provider of this stack (the Google
    // credentials are empty, so this is the only way to staff accounts other than the break-glass one).
    DEV_LOGIN_ENABLED: 'true',
    STATUS_PAGE_PUBLIC: 'true',
    LINE_LOGIN_FAKE_ENABLED: 'true',
    // Cheap proof of work and no wait, but the checks themselves stay on (ADR-007).
    PORTAL_POW_DIFFICULTY_BITS: '10',
    PORTAL_MIN_FILL_SECONDS: '1',
    PORTAL_RATE_IP_PER_HOUR: '1000',
    PORTAL_RATE_EMAIL_PER_HOUR: '1000',
    PORTAL_RATE_ORG_PER_HOUR: '1000',
  });
  start('web', [join(root, 'apps', 'web', 'scripts', 'start-standalone.mjs')], {
    ...base,
    ...guarded,
    API_URL: apiUrl,
    HOSTNAME: '127.0.0.1',
    PORT: String(WEB_PORT),
  });

  await Promise.all([
    waitFor(`${apiUrl}/health/ready`, 'api'),
    waitFor(`http://127.0.0.1:${String(WORKER_PORT)}/health/ready`, 'worker'),
    waitFor(`${webUrl}/health`, 'web'),
  ]);

  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      webUrl,
      apiUrl,
      mailpitUrl: MAILPIT_URL,
      breakGlassEmail,
      breakGlassPassword,
      database: database.name,
      logDir,
      env: {
        E2E_DATABASE_URL: database.appUrl,
        E2E_LINE_CHANNEL_SECRET: lineChannelSecret,
        E2E_ALERT_WEBHOOK_SECRET: alertWebhookSecret,
        E2E_DISCORD_PRIVATE_KEY: discordPrivateKeyPem,
        E2E_NET_LOG: netLog,
        E2E_LINE_LOG: lineLog,
        E2E_API_DIST: join(root, 'apps', 'api', 'dist'),
      },
    }),
    { mode: 0o600 },
  );
  console.log(`READY ${stateFile}`);
}

main().catch((error) => {
  console.error(`[e2e-stack] ${error instanceof Error ? error.message : String(error)}`);
  void stop(1);
});
