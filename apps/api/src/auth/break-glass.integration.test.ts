import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '@watchtower/db';
import type { SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { provisionBreakGlass } from './break-glass-provision.js';
import { BreakGlassBootstrap, LOCKOUT_THRESHOLD } from './break-glass.service.js';
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

async function account() {
  const result = await pool().query<{
    id: string;
    role: string;
    status: string;
    is_break_glass: boolean;
    password_hash: string;
    failed_login_count: number;
    locked_until: Date | null;
  }>(
    `SELECT id, role, status, is_break_glass, password_hash, failed_login_count, locked_until FROM users WHERE email = $1`,
    [EMAIL],
  );
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
      await pool().query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1`,
        [EMAIL],
      );
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
    await pool().query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1`,
      [EMAIL],
    );
  });

  it('spends the cost of a password check even when the account does not exist', async () => {
    const passwords = new PasswordService();
    const hash = await passwords.hash('timing-reference-password');
    const started = performance.now();
    await passwords.verify(hash, 'timing-reference-password');
    const oneCheck = performance.now() - started;

    const client = h.client();
    const unknownStart = performance.now();
    await client.post('/v1/auth/break-glass', { email: uniqueEmail('ghost'), password: PASSWORD });
    const unknown = performance.now() - unknownStart;
    expect(unknown).toBeGreaterThan(oneCheck * 0.5);
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

describe('lockout', () => {
  it(`locks the account after ${String(LOCKOUT_THRESHOLD)} wrong passwords, even for the right one`, async () => {
    await pool().query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1`,
      [EMAIL],
    );
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      const response = await h.client().post('/v1/auth/break-glass', {
        email: EMAIL,
        password: `wrong-${String(attempt)}-password`,
      });
      expect(response.status).toBe(401);
    }
    const locked = await account();
    expect(locked?.failed_login_count).toBe(LOCKOUT_THRESHOLD);
    expect(locked?.locked_until && locked.locked_until.getTime() > Date.now()).toBe(true);

    const withRightPassword = await h.client().post<{ code: string }>('/v1/auth/break-glass', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(withRightPassword.status).toBe(401);
    expect(withRightPassword.body.code).toBe('invalid_credentials');
    expect(
      (await auditActions()).filter((action) => action === 'auth.break_glass.locked').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('lets the right password in again once the lock has passed, and clears the count', async () => {
    await pool().query(
      `UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`,
      [EMAIL],
    );
    const response = await h
      .client()
      .post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await account()).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  it('counts parallel guesses exactly, so they cannot slip under the threshold', async () => {
    await pool().query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1`,
      [EMAIL],
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        h.client().post('/v1/auth/break-glass', {
          email: EMAIL,
          password: `parallel-guess-${String(index)}`,
        }),
      ),
    );
    expect((await account())?.failed_login_count).toBe(4);
    await pool().query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1`,
      [EMAIL],
    );
  });

  it('forgets earlier mistakes after a successful sign-in', async () => {
    await h
      .client()
      .post('/v1/auth/break-glass', { email: EMAIL, password: 'one-mistake-password' });
    expect((await account())?.failed_login_count).toBe(1);
    expect(
      (await h.client().post('/v1/auth/break-glass', { email: EMAIL, password: PASSWORD })).status,
    ).toBe(200);
    expect((await account())?.failed_login_count).toBe(0);
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

  it('needs a password and a database', async () => {
    expect((await run([uniqueEmail('x')], { DATABASE_URL: h.db.ownerUrl })).code).toBe(2);
    expect((await run([uniqueEmail('x')], { BREAK_GLASS_PASSWORD: PASSWORD })).code).toBe(2);
    expect(
      (await run([], { DATABASE_URL: h.db.ownerUrl, BREAK_GLASS_PASSWORD: PASSWORD })).code,
    ).toBe(2);
  });
});
