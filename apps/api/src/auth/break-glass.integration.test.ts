import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '@watchtower/db';
import type { SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { provisionBreakGlass } from './break-glass-provision.js';
import {
  BreakGlassBootstrap,
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
  LOCKOUT_THRESHOLD,
  lockSeconds,
} from './break-glass.service.js';
import { PasswordService } from './password.service.js';

// The break-glass local admin on the real application. The passwords below exist only in this
// test: nothing in the repository or the application has a default.

const EMAIL = uniqueEmail('break-glass');
const PASSWORD = 'test-only-Passw0rd-for-break-glass';
const logs = captureLogs();

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    env: { BREAK_GLASS_EMAIL: EMAIL, BREAK_GLASS_PASSWORD: PASSWORD, LOG_LEVEL: 'debug' },
    logs,
  });
  await h.app.get(BreakGlassBootstrap).whenSettled();
});

afterAll(async () => {
  await h.close();
});

const pool = () => h.db.owner.pool;

async function clearLockouts(): Promise<void> {
  await pool().query('DELETE FROM break_glass_attempt');
}

async function attemptsFor(ip: string) {
  const result = await pool().query<{
    failed_count: number;
    locked_until: Date | null;
    seconds_left: number | null;
  }>(
    `SELECT failed_count, locked_until,
            extract(epoch FROM locked_until - now())::float AS seconds_left
     FROM break_glass_attempt WHERE ip = $1`,
    [ip],
  );
  return result.rows[0];
}

async function account() {
  const result = await pool().query<{
    id: string;
    role: string;
    status: string;
    is_break_glass: boolean;
    password_hash: string;
  }>(`SELECT id, role, status, is_break_glass, password_hash FROM users WHERE email = $1`, [EMAIL]);
  return result.rows[0];
}

async function auditActions(): Promise<string[]> {
  const result = await pool().query<{ action: string }>(
    `SELECT action FROM audit_log WHERE action LIKE 'auth.%break_glass%' OR action = 'auth.login.break_glass' ORDER BY created_at`,
  );
  return result.rows.map((row) => row.action);
}

describe('provisioning from the environment', () => {
  it('creates a head account with an argon2id hash, and never stores the password', async () => {
    const row = await account();
    expect(row).toMatchObject({ role: 'head', status: 'active', is_break_glass: true });
    expect(row?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row?.password_hash).not.toContain(PASSWORD);
    const dump = await pool().query<{ dump: string }>(
      `SELECT string_agg(to_jsonb(u)::text, ' ') AS dump FROM users u`,
    );
    expect(dump.rows[0]?.dump).not.toContain(PASSWORD);
  });

  it('records who created it: the system, from the environment', async () => {
    const rows = await pool().query<{
      actor_type: string;
      actor_id: string;
      metadata: { source: string };
    }>(
      `SELECT actor_type, actor_id, metadata FROM audit_log WHERE action = 'auth.break_glass.provisioned'`,
    );
    expect(rows.rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'bootstrap',
      metadata: { source: 'environment' },
    });
  });

  it('is idempotent, and a new password in the environment replaces the old one', async () => {
    const database = createDatabase({ url: h.db.ownerUrl, max: 1 });
    try {
      const passwords = new PasswordService();
      expect(await provisionBreakGlass(database, passwords, EMAIL, PASSWORD)).toBe('unchanged');
      const before = (await account())?.password_hash;
      const rotated = 'rotated-Passw0rd-for-break-glass';
      expect(await provisionBreakGlass(database, passwords, EMAIL, rotated)).toBe('updated');
      expect((await account())?.password_hash).not.toBe(before);

      const client = h.client();
      expect(
        (await client.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
      ).toBe(401);
      expect(
        (await client.post('/v1/auth/break-glass', { email: EMAIL, password: rotated })).status,
      ).toBe(200);
      expect(await provisionBreakGlass(database, passwords, EMAIL, PASSWORD)).toBe('updated');
      await clearLockouts();
    } finally {
      await database.close();
    }
  });

  it('refuses a short password, a bad address and an address that already has a normal account', async () => {
    const database = createDatabase({ url: h.db.ownerUrl, max: 1 });
    try {
      const passwords = new PasswordService();
      await expect(
        provisionBreakGlass(database, passwords, uniqueEmail('x'), 'short'),
      ).rejects.toThrow(/at least 12/);
      await expect(
        provisionBreakGlass(database, passwords, 'not-an-email', PASSWORD),
      ).rejects.toThrow(/email/);
      const normal = uniqueEmail('normal');
      await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'N', 'head')`, [
        normal,
      ]);
      await expect(provisionBreakGlass(database, passwords, normal, PASSWORD)).rejects.toThrow(
        /normal account/,
      );
      const after = await pool().query(
        'SELECT is_break_glass, password_hash FROM users WHERE email = $1',
        [normal],
      );
      expect(after.rows[0]).toEqual({ is_break_glass: false, password_hash: null });
    } finally {
      await database.close();
    }
  });
});

describe('signing in', () => {
  it('gives the head role a session, and audits it', async () => {
    const client = h.client();
    const response = await client.post<SessionInfo>('/v1/auth/break-glass', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: EMAIL, role: 'head' });
    expect(response.body.authMethod).toBe('break_glass');
    expect(response.body.permissions).toContain('audit.read');
    client.csrfToken = response.body.csrfToken;
    expect((await client.get('/v1/audit-logs')).status).toBe(200);

    const rows = await pool().query<{ actor_type: string; actor_id: string; outcome: string }>(
      `SELECT actor_type, actor_id, outcome FROM audit_log WHERE action = 'auth.login.break_glass' AND actor_id = $1`,
      [(await account())?.id],
    );
    expect(rows.rows.at(-1)).toMatchObject({ actor_type: 'user', outcome: 'success' });
  });

  it('answers a wrong password, an unknown account and a normal account identically', async () => {
    const normal = uniqueEmail('plain-head');
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'P', 'head')`, [normal]);
    const bodies: unknown[] = [];
    for (const credentials of [
      { email: EMAIL, password: 'definitely-the-wrong-password' },
      { email: uniqueEmail('nobody'), password: PASSWORD },
      { email: normal, password: PASSWORD },
    ]) {
      const response = await h.client().post('/v1/auth/break-glass', credentials);
      expect(response.status).toBe(401);
      bodies.push(response.body);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: 'invalid_credentials' });
    await clearLockouts();
  });

  it('counts an IPv6 client as its /64: new addresses inside it share one lockout (T-125 C-7)', async () => {
    await clearLockouts();
    const client = h.client();
    const prefix = '2001:db8:7a:1';
    // Five wrong passwords, each from a different address of the same /64.
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      const hex = attempt.toString(16);
      const response = await client.post(
        '/v1/auth/break-glass',
        { email: EMAIL, password: `wrong-password-${String(attempt)}` },
        { headers: { 'x-forwarded-for': `${prefix}::${hex}:${hex}` } },
      );
      expect(response.status).toBe(401);
    }
    const row = await attemptsFor('2001:0db8:007a:0001::/64');
    expect(row?.failed_count).toBe(LOCKOUT_THRESHOLD);
    expect(row?.seconds_left).toBeGreaterThan(0);
    // A sixth address of the /64 is locked out even with the right password; another /64 is not.
    const sixth = await client.post(
      '/v1/auth/break-glass',
      { email: EMAIL, password: PASSWORD },
      { headers: { 'x-forwarded-for': `${prefix}:ffff:ffff:ffff:ffff` } },
    );
    expect(sixth.status).toBe(401);
    const elsewhere = await client.post(
      '/v1/auth/break-glass',
      { email: EMAIL, password: PASSWORD },
      { headers: { 'x-forwarded-for': '2001:db8:7a:2::1' } },
    );
    expect(elsewhere.status).toBe(200);
    await clearLockouts();
  });

  it('spends the cost of a password check even when the account does not exist', async () => {
    // Timing under load (T-125): both sides are the fastest of several tries, so a CPU spike during
    // one measurement cannot make the unknown account look cheaper than a real check. The point is
    // that the ghost request is not a quick early return (a missing hash is microseconds, a check
    // is tens of milliseconds), so half of the cheapest real check is a wide margin.
    const passwords = new PasswordService();
    const hash = await passwords.hash('timing-reference-password');
    const checks: number[] = [];
    const ghosts: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      await passwords.verify(hash, 'timing-reference-password');
      checks.push(performance.now() - started);
      const ghostStart = performance.now();
      await h
        .client()
        .post('/v1/auth/break-glass', { email: uniqueEmail('ghost'), password: PASSWORD });
      ghosts.push(performance.now() - ghostStart);
    }
    expect(Math.min(...ghosts)).toBeGreaterThan(Math.min(...checks) * 0.5);
  });

  it('refuses a disabled account', async () => {
    await pool().query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [EMAIL]);
    try {
      const response = await h
        .client()
        .post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD });
      expect(response.status).toBe(401);
    } finally {
      await pool().query(`UPDATE users SET status = 'active' WHERE email = $1`, [EMAIL]);
    }
  });

  it('rejects malformed input before checking anything', async () => {
    const client = h.client();
    expect((await client.post('/v1/auth/break-glass', { email: EMAIL })).status).toBe(400);
    expect((await client.post('/v1/auth/break-glass', { email: EMAIL, password: '' })).status).toBe(
      400,
    );
    expect(
      (await client.post('/v1/auth/break-glass', { email: EMAIL, password: 'x'.repeat(300) }))
        .status,
    ).toBe(400);
    expect(
      (await client.post('/v1/auth/break-glass', { email: 'nope', password: PASSWORD })).status,
    ).toBe(400);
  });
});

describe('lockout per (account, IP address) with exponential backoff (C-7)', () => {
  const wrong = (client: TestClient, n: number | string) =>
    client.post<{ code: string }>('/v1/auth/break-glass', {
      email: EMAIL,
      password: `wrong-${String(n)}-password`,
    });

  it('computes the lock length: none below the threshold, then 60 s doubling up to an hour', () => {
    expect([1, 4].map(lockSeconds)).toEqual([0, 0]);
    expect([5, 6, 7, 8].map(lockSeconds)).toEqual([60, 120, 240, 480]);
    expect(lockSeconds(11)).toBe(LOCKOUT_MAX_SECONDS);
    expect(lockSeconds(500)).toBe(LOCKOUT_MAX_SECONDS);
  });

  it(`locks the address after ${String(LOCKOUT_THRESHOLD)} wrong passwords, even for the right one, and no other address`, async () => {
    await clearLockouts();
    const attacker = h.client();
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      expect((await wrong(attacker, attempt)).status).toBe(401);
    }
    const locked = await attemptsFor(attacker.ip);
    expect(locked?.failed_count).toBe(LOCKOUT_THRESHOLD);
    expect(locked?.seconds_left).toBeGreaterThan(LOCKOUT_BASE_SECONDS - 10);
    expect(locked?.seconds_left).toBeLessThanOrEqual(LOCKOUT_BASE_SECONDS);

    // The attacker's address is out, whatever it types ...
    const retry = await attacker.post<{ code: string }>('/v1/auth/break-glass', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(retry.status).toBe(401);
    expect(retry.body.code).toBe('invalid_credentials');
    // ... and the real admin, from somewhere else, is not.
    const admin = h.client();
    expect(
      (await admin.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(200);
    expect(await attemptsFor(admin.ip)).toBeUndefined();

    const actions = await auditActions();
    expect(
      actions.filter((action) => action === 'auth.break_glass.locked').length,
    ).toBeGreaterThanOrEqual(1);
    expect(actions).toContain('auth.break_glass.lockout');
  });

  it('writes an audit row and a warning when a lock is applied, and none for the earlier failures', async () => {
    await clearLockouts();
    const client = h.client();
    const lockoutRows = () =>
      pool().query<{
        outcome: string;
        target_id: string;
        metadata: { failedAttempts: number; lockedForSeconds: number };
      }>(
        `SELECT outcome, target_id, metadata FROM audit_log
         WHERE action = 'auth.break_glass.lockout' AND ip = $1`,
        [client.ip],
      );
    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt += 1) await wrong(client, attempt);
    expect((await lockoutRows()).rows).toHaveLength(0);

    await wrong(client, LOCKOUT_THRESHOLD);
    const rows = await lockoutRows();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      outcome: 'denied',
      target_id: (await account())?.id,
      metadata: { failedAttempts: LOCKOUT_THRESHOLD, lockedForSeconds: LOCKOUT_BASE_SECONDS },
    });
    const warning = logs
      .lines()
      .find(
        (line) =>
          typeof line.msg === 'string' &&
          line.msg.includes('break-glass sign-in locked') &&
          line.ip === client.ip,
      );
    expect(warning).toMatchObject({ level: 'warn', failedAttempts: LOCKOUT_THRESHOLD });
    expect(JSON.stringify(warning)).not.toContain('wrong-');
  });

  it('doubles the lock with each further wrong password from that address, up to an hour', async () => {
    await clearLockouts();
    const client = h.client();
    const userId = (await account())?.id;
    await pool().query(
      `INSERT INTO break_glass_attempt (user_id, ip, failed_count, locked_until)
       VALUES ($1, $2, $3, now() - interval '1 second')`,
      [userId, client.ip, LOCKOUT_THRESHOLD],
    );
    await wrong(client, 'six');
    let row = await attemptsFor(client.ip);
    expect(row?.failed_count).toBe(LOCKOUT_THRESHOLD + 1);
    expect(row?.seconds_left).toBeGreaterThan(2 * LOCKOUT_BASE_SECONDS - 10);
    expect(row?.seconds_left).toBeLessThanOrEqual(2 * LOCKOUT_BASE_SECONDS);

    await pool().query(
      `UPDATE break_glass_attempt SET locked_until = now() - interval '1 second' WHERE ip = $1`,
      [client.ip],
    );
    await wrong(client, 'seven');
    row = await attemptsFor(client.ip);
    expect(row?.failed_count).toBe(LOCKOUT_THRESHOLD + 2);
    expect(row?.seconds_left).toBeGreaterThan(4 * LOCKOUT_BASE_SECONDS - 10);

    await pool().query(
      `UPDATE break_glass_attempt SET failed_count = 40, locked_until = now() - interval '1 second' WHERE ip = $1`,
      [client.ip],
    );
    await wrong(client, 'many');
    row = await attemptsFor(client.ip);
    expect(row?.failed_count).toBe(41);
    expect(row?.seconds_left).toBeLessThanOrEqual(LOCKOUT_MAX_SECONDS);
    expect(row?.seconds_left).toBeGreaterThan(LOCKOUT_MAX_SECONDS - 10);
  });

  it('does not extend a lock by guessing during it', async () => {
    await clearLockouts();
    const client = h.client();
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) await wrong(client, attempt);
    const first = await attemptsFor(client.ip);
    await wrong(client, 'during-lock');
    const second = await attemptsFor(client.ip);
    expect(second?.failed_count).toBe(first?.failed_count);
    expect(second?.locked_until?.getTime()).toBe(first?.locked_until?.getTime());
  });

  it('lets the right password in again once the lock has passed, and forgets that address', async () => {
    await clearLockouts();
    const client = h.client();
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) await wrong(client, attempt);
    await pool().query(
      `UPDATE break_glass_attempt SET locked_until = now() - interval '1 second' WHERE ip = $1`,
      [client.ip],
    );
    const response = await client.post('/v1/auth/break-glass', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(await attemptsFor(client.ip)).toBeUndefined();
  });

  it('counts parallel guesses from one address exactly, so they cannot slip under the threshold', async () => {
    await clearLockouts();
    const client = h.client();
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => wrong(client, `parallel-${String(index)}`)),
    );
    expect((await attemptsFor(client.ip))?.failed_count).toBe(4);
    await wrong(client, 'parallel-last');
    expect((await attemptsFor(client.ip))?.seconds_left).toBeGreaterThan(0);
  });

  it('starts counting again after a quiet day', async () => {
    await clearLockouts();
    const client = h.client();
    await pool().query(
      `INSERT INTO break_glass_attempt (user_id, ip, failed_count, last_failed_at)
       VALUES ($1, $2, 4, now() - interval '25 hours')`,
      [(await account())?.id, client.ip],
    );
    await wrong(client, 'after-a-day');
    expect(await attemptsFor(client.ip)).toMatchObject({ failed_count: 1, locked_until: null });
  });

  it('forgets earlier mistakes after a successful sign-in', async () => {
    await clearLockouts();
    const client = h.client();
    await wrong(client, 'one-mistake');
    expect((await attemptsFor(client.ip))?.failed_count).toBe(1);
    expect(
      (await client.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(200);
    expect(await attemptsFor(client.ip)).toBeUndefined();
  });

  it('keeps the counters per account: a lock on one account does not touch another', async () => {
    await clearLockouts();
    const database = createDatabase({ url: h.db.ownerUrl, max: 1 });
    const other = uniqueEmail('second-admin');
    try {
      await provisionBreakGlass(database, new PasswordService(), other, PASSWORD);
    } finally {
      await database.close();
    }
    const client = h.client();
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) await wrong(client, attempt);
    const second = await client.post('/v1/auth/break-glass', { email: other, password: PASSWORD });
    expect(second.status).toBe(200);
  });
});

describe('rate limit', () => {
  it('allows 10 attempts per IP address per window, then 429 with Retry-After', async () => {
    const client = h.client();
    const statuses: number[] = [];
    let last: { headers: Headers; body: unknown } | undefined;
    for (let i = 0; i < 12; i += 1) {
      const response = await client.post('/v1/auth/break-glass', {
        email: uniqueEmail('spray'),
        password: 'spraying-guesses-password',
      });
      statuses.push(response.status);
      last = response;
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(last?.body).toMatchObject({ code: 'rate_limited' });
    expect(await auditActions()).toContain('auth.break_glass.rate_limited');
  });

  it('counts each IP address separately', async () => {
    const other = h.client();
    expect(
      (await other.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(200);
  });
});

describe('everything is audited, nothing secret is', () => {
  it('has an entry for each kind of attempt', async () => {
    const actions = new Set(await auditActions());
    for (const expected of [
      'auth.break_glass.provisioned',
      'auth.login.break_glass',
      'auth.break_glass.failed',
      'auth.break_glass.locked',
      'auth.break_glass.lockout',
      'auth.break_glass.rate_limited',
    ]) {
      expect(actions, expected).toContain(expected);
    }
  });

  it('never wrote a password, a token or a cookie to the audit log or the application log', async () => {
    const audit = await pool().query<{ dump: string }>(
      `SELECT string_agg(to_jsonb(a)::text, ' ') AS dump FROM audit_log a`,
    );
    const dump = audit.rows[0]?.dump ?? '';
    const log = logs.raw();
    const secrets = [
      PASSWORD,
      'definitely-the-wrong-password',
      'rotated-Passw0rd-for-break-glass',
      'wrong-1-password',
    ];
    for (const secret of secrets) {
      expect(dump, `audit log contains ${secret.slice(0, 6)}...`).not.toContain(secret);
      expect(log, `application log contains ${secret.slice(0, 6)}...`).not.toContain(secret);
    }
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(dump).not.toContain('$argon2');
    expect(log).not.toContain('$argon2');
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
  });
});

describe('command line', () => {
  const cli = fileURLToPath(new URL('../cli/break-glass.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));

  function run(args: string[], env: Record<string, string>, stdin?: string) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
          cwd,
          env: { PATH: process.env.PATH ?? '', ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code, stdout, stderr });
        });
        child.stdin.end(stdin ?? '');
      },
    );
  }

  it('creates the account from a piped password and never accepts one on the command line', async () => {
    const email = uniqueEmail('cli-admin');
    const piped = 'piped-Passw0rd-from-stdin';
    const created = await run([email], { DATABASE_URL: h.db.ownerUrl }, `${piped}\n`);
    expect(created.stderr).toBe('');
    expect(created.stdout).toContain('created');
    expect(created.stdout + created.stderr).not.toContain(piped);

    const signedIn = await h.client().post('/v1/auth/break-glass', { email, password: piped });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ user: { role: 'head' } });

    // A second argument is refused rather than treated as a password.
    const withArgument = await run([email, piped], { DATABASE_URL: h.db.ownerUrl }, `${piped}\n`);
    expect(withArgument.code).toBe(2);
  });

  it('takes the password from the environment, refuses a short one, and says nothing secret', async () => {
    const email = uniqueEmail('cli-env');
    const ok = await run([email], { DATABASE_URL: h.db.ownerUrl, BREAK_GLASS_PASSWORD: PASSWORD });
    expect(ok.code).toBe(0);
    const short = await run([uniqueEmail('cli-short')], {
      DATABASE_URL: h.db.ownerUrl,
      BREAK_GLASS_PASSWORD: 'short-pw',
    });
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('at least 12');
    expect(short.stdout + short.stderr).not.toContain('short-pw');
    expect(short.stdout + short.stderr).not.toContain(h.db.ownerUrl);
  });

  it('--unlock clears every lockout of the account, needs no password, and is audited', async () => {
    await clearLockouts();
    const attacker = h.client();
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      await attacker.post('/v1/auth/break-glass', {
        email: EMAIL,
        password: `cli-wrong-${String(attempt)}`,
      });
    }
    expect((await attemptsFor(attacker.ip))?.seconds_left).toBeGreaterThan(0);
    expect(
      (await attacker.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(401);

    const result = await run(['--unlock', EMAIL], { DATABASE_URL: h.db.ownerUrl });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('unlocked');
    expect(result.stdout + result.stderr).not.toContain(h.db.ownerUrl);
    expect(await attemptsFor(attacker.ip)).toBeUndefined();
    expect(
      (await attacker.post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(200);

    const audit = await pool().query<{ actor_type: string; actor_id: string; metadata: unknown }>(
      `SELECT actor_type, actor_id, metadata FROM audit_log WHERE action = 'auth.break_glass.unlocked'`,
    );
    expect(audit.rows.at(-1)).toMatchObject({
      actor_type: 'system',
      actor_id: 'break-glass-cli',
      metadata: { clearedAddresses: 1 },
    });
  });

  it('--unlock refuses an address that is not a break-glass account, and a stray argument', async () => {
    const normal = uniqueEmail('not-break-glass');
    await pool().query(`INSERT INTO users (email, name, role) VALUES ($1, 'N', 'head')`, [normal]);
    const notBreakGlass = await run(['--unlock', normal], { DATABASE_URL: h.db.ownerUrl });
    expect(notBreakGlass.code).toBe(1);
    expect(notBreakGlass.stderr).toContain('no break-glass account');
    expect((await run(['--unlock', EMAIL, 'extra'], { DATABASE_URL: h.db.ownerUrl })).code).toBe(2);
    expect((await run(['--unlock'], { DATABASE_URL: h.db.ownerUrl })).code).toBe(2);
  });

  it('needs a password and a database', async () => {
    expect((await run([uniqueEmail('x')], { DATABASE_URL: h.db.ownerUrl })).code).toBe(2);
    expect((await run([uniqueEmail('x')], { BREAK_GLASS_PASSWORD: PASSWORD })).code).toBe(2);
    expect(
      (await run([], { DATABASE_URL: h.db.ownerUrl, BREAK_GLASS_PASSWORD: PASSWORD })).code,
    ).toBe(2);
  });
});
