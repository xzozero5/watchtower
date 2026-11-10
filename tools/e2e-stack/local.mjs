// One local run owns its infra. Never reuse a compose service or a caller's E2E URLs.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = `wt-local-${randomBytes(6).toString('hex')}`;
const containers = [];
let child;
let interrupted = false;

function docker(args) {
  // Never forward Docker error output: it can contain generated credentials.
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

function start(suffix, image, ports, options = []) {
  const name = `${run}-${suffix}`;
  // Register before start, so partial startup is cleaned up too. Names are random per run.
  containers.push(name);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `watchtower.e2e.run=${run}`,
    ...ports.flatMap((port) => ['-p', `127.0.0.1::${port}`]),
    ...options,
    image,
  ]);
  return ports.map((port) => {
    const binding = docker(['port', name, `${port}/tcp`]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('Unexpected Docker port binding');
    return Number(match[1]);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function pnpm(args, env) {
  if (!process.env.npm_execpath) throw new Error('Run with pnpm e2e:local');
  if (interrupted) throw new Error('Interrupted');
  await new Promise((resolve, reject) => {
    const launcher = process.env.npm_execpath;
    const native = /\.exe$/i.test(launcher);
    child = spawn(native ? launcher : process.execPath, native ? args : [launcher, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error('Build or E2E failed; see output above'));
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else process.kill(-child.pid, signal);
    } catch {
      // The owned process tree may already have exited.
    }
  });
}

try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const password = randomBytes(24).toString('hex');
  const [pg] = start(
    'pg',
    'pgvector/pgvector:0.8.7-pg16-trixie',
    [5432],
    [
      '-e',
      'POSTGRES_USER=watchtower',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=watchtower',
      '--health-cmd',
      'pg_isready -U watchtower -d watchtower',
      '--health-interval',
      '1s',
      '--health-retries',
      '60',
    ],
  );
  const [redis] = start('redis', 'redis:7.4-alpine', [6379]);
  const [smtp, mail] = start('mail', 'axllent/mailpit:v1.33.0', [1025, 8025]);
  const deadline = Date.now() + 60_000;
  while (docker(['inspect', '--format', '{{.State.Health.Status}}', `${run}-pg`]) !== 'healthy') {
    if (Date.now() >= deadline || interrupted) throw new Error('Postgres startup failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Drop inherited test settings so an external stack/provider cannot be selected accidentally.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(E2E_|TEST_|AI_|EMBEDDING_|INSIGHT_)/.test(key),
    ),
  );
  Object.assign(env, {
    E2E_STACK: 'spawn',
    E2E_ADMIN_DATABASE_URL: `postgres://watchtower:${password}@127.0.0.1:${pg}/watchtower`,
    E2E_REDIS_URL: `redis://127.0.0.1:${redis}/9`,
    E2E_MAILPIT_URL: `http://127.0.0.1:${mail}`,
    E2E_SMTP_HOST: '127.0.0.1',
    E2E_SMTP_PORT: String(smtp),
    E2E_WEB_PORT: String(await freePort()),
    E2E_API_PORT: String(await freePort()),
    E2E_WORKER_PORT: String(await freePort()),
    E2E_PORT: String(await freePort()),
    E2E_KEEP_LOGS: '1',
    AI_AUTOSEND_ENABLED: 'false',
    INSIGHT_PERSON_NARRATION_ENABLED: 'false',
    EMBEDDING_PROVIDER: 'mock',
    NEXT_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    // Keep browser selection from the caller; tests run only against loopback.
    PW_CHANNEL: process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : ''),
  });
  console.log(`[e2e-local] ${run}: isolated infra ready; build → browser → full-stack`);
  await pnpm(['build'], env);
  await pnpm(['--filter', '@watchtower/web', 'test:e2e', '--workers=2'], env);
  await pnpm(['--filter', '@watchtower/web', 'test:e2e:fullstack'], env);
  console.log('[e2e-local] All stages passed. External adapters/AI used test fixtures.');
} catch {
  console.error('[e2e-local] Run failed or interrupted. Check stage output; credentials withheld.');
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) {
    try {
      if (
        docker(['inspect', '--format', '{{index .Config.Labels "watchtower.e2e.run"}}', name]) !==
        run
      ) {
        console.error(`[e2e-local] Ownership mismatch for ${name}; left untouched.`);
        process.exitCode = 1;
        continue;
      }
      docker(['rm', '-f', '-v', name]);
    } catch {
      console.error(`[e2e-local] Could not clean owned container ${name}; inspect it manually.`);
      process.exitCode = 1;
    }
  }
}
