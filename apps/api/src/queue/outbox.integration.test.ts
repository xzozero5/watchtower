import { relayOutbox } from '@watchtower/db';
import { QUEUE_NAMES } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey, openFields, outboxAad } from '@watchtower/shared/secret-box';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MagicLinkService } from '../auth/magic-link.service.js';
import { createOrg, startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { OutboxService } from './queue.module.js';

// The api side of the transactional outbox (ADR-006): it only ever writes rows. Whether Redis is up
// does not matter to a request. The relay itself runs in apps/worker; here the harness runs one
// pass of the same `relayOutbox` against the same BullMQ queue.

let h: Harness;
let orgId: string;
const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  orgId = await createOrg(pool());
});

afterAll(async () => {
  await h.close();
});

async function createClient(): Promise<string> {
  const email = uniqueEmail('outbox-client');
  await pool().query(
    `INSERT INTO users (email, name, role, org_id) VALUES ($1, 'Client', 'client', $2)`,
    [email, orgId],
  );
  return email;
}

async function requestLink(email: string): Promise<void> {
  expect((await h.client().post('/v1/auth/magic-link/request', { email })).status).toBe(202);
  await h.app.get(MagicLinkService).whenIdle();
}

/** The outbox rows of the magic links requested for `email`. The address is known only while pending. */
async function outboxRowFor(email: string) {
  const { rows } = await pool().query<{
    id: string;
    job_id: string;
    status: string;
    payload: { to?: string; link?: string; secret?: string };
    queue: string;
    job_name: string;
    options: Record<string, unknown>;
    expires_at: Date | null;
  }>(
    `SELECT id, job_id, status, payload, queue, job_name, options, expires_at FROM outbox
     WHERE job_id IN (SELECT 'magic-link-' || substr(t.token_hash, 1, 32)
                      FROM magic_link_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1)`,
    [email],
  );
  return rows;
}

async function queuedFor(email: string) {
  const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.filter((job) => (job.data as { to?: string }).to === email);
}

describe('email through the outbox', () => {
  it('writes the email as a pending outbox row and puts nothing in Redis by itself', async () => {
    const email = await createClient();
    await requestLink(email);

    const rows = await outboxRowFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      queue: QUEUE_NAMES.email,
      job_name: 'send',
      options: { attempts: 5, removeOnComplete: true },
    });
    // The link is sealed at rest; the clear part still says what the email is.
    const payload = rows[0]?.payload ?? {};
    expect(payload).toMatchObject({ kind: 'magic_link', to: email });
    expect(payload.secret).toMatch(/^v1\./);
    expect(payload).not.toHaveProperty('link');
    expect(JSON.stringify(payload)).not.toContain('/login/magic');
    expect(rows[0]?.expires_at).toBeInstanceOf(Date);
    // No relay has run: BullMQ has not heard of it.
    expect(await queuedFor(email)).toHaveLength(0);
  });

  it('delivers the pending row when the relay runs, marks it sent and blanks the link', async () => {
    const email = await createClient();
    await requestLink(email);
    const result = await h.relayOutbox();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const jobs = await queuedFor(email);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('send');
    const rows = await pool().query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM outbox WHERE job_id = $1`,
      [jobs[0]?.id],
    );
    expect(rows.rows[0]).toMatchObject({ status: 'sent', payload: {} });
  });

  it('survives a Redis outage: the request succeeds, the row stays pending, and a later pass delivers it', async () => {
    const email = await createClient();
    await requestLink(email);

    // The relay cannot reach Redis (the publisher throws what ioredis throws).
    const down = await relayOutbox(h.db.owner, () =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    );
    expect(down.sent).toBe(0);
    expect(down.retried).toBeGreaterThanOrEqual(1);
    const [pending] = await outboxRowFor(email);
    expect(pending?.status).toBe('pending');
    expect(await queuedFor(email)).toHaveLength(0);

    // Redis is back; the backoff of the failed row passes.
    await pool().query(
      `UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [pending?.id],
    );
    await h.relayOutbox();
    expect(await queuedFor(email)).toHaveLength(1);
    expect((await outboxRowFor(email))[0]?.status).toBe('sent');
  });

  it('expires a magic-link email with the link itself (MAGIC_LINK_TTL_SECONDS)', async () => {
    const email = await createClient();
    const before = Date.now();
    await requestLink(email);
    const [row] = await outboxRowFor(email);
    const lifetime = (row?.expires_at?.getTime() ?? 0) - before;
    expect(lifetime).toBeGreaterThan(h.config.MAGIC_LINK_TTL_SECONDS * 1000 - 5000);
    expect(lifetime).toBeLessThan(h.config.MAGIC_LINK_TTL_SECONDS * 1000 + 5000);
  });

  it('never relays a link that expired in the outbox: dead, payload blanked, nothing in Redis', async () => {
    const email = await createClient();
    await requestLink(email);
    const [row] = await outboxRowFor(email);
    expect(row?.payload.secret).toBeDefined();
    await pool().query(`UPDATE outbox SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      row?.id,
    ]);
    const result = await h.relayOutbox();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await queuedFor(email)).toHaveLength(0);
    const [after] = await outboxRowFor(email);
    expect(after).toMatchObject({ status: 'dead', payload: {} });
  });

  it('seals only the secret part, bound to the queue and job id it was written for', async () => {
    const outbox = h.app.get(OutboxService);
    const jobId = `sealed-${uniqueEmail('s')}`;
    const link = 'http://localhost:3000/login/magic#token=THE-SECRET-VALUE';
    await outbox.enqueue({
      queue: QUEUE_NAMES.email,
      name: 'send',
      jobId,
      payload: { kind: 'magic_link', to: 'sealed@example.com', expiresInMinutes: 15 },
      secret: { link },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const stored = await pool().query<{ payload: Record<string, unknown>; expires_at: Date }>(
      'SELECT payload, expires_at FROM outbox WHERE job_id = $1',
      [jobId],
    );
    const payload = stored.rows[0]?.payload ?? {};
    expect(payload).toMatchObject({ kind: 'magic_link', to: 'sealed@example.com' });
    expect(JSON.stringify(payload)).not.toContain('THE-SECRET-VALUE');
    expect(stored.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

    const key = deriveSubkey(h.config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret);
    const sealed = String(payload.secret);
    expect(openFields(key, sealed, outboxAad(QUEUE_NAMES.email, jobId))).toEqual({ link });
    // Copied onto another job, or opened with another key, it is useless.
    expect(() => openFields(key, sealed, outboxAad(QUEUE_NAMES.email, 'another-job'))).toThrow();
    expect(() =>
      openFields(
        deriveSubkey(h.config.APP_ENCRYPTION_KEY, 'other'),
        sealed,
        outboxAad(QUEUE_NAMES.email, jobId),
      ),
    ).toThrow();
  });

  it('refuses a payload that already has a secret key of its own', async () => {
    await expect(
      h.app.get(OutboxService).enqueue({
        queue: QUEUE_NAMES.email,
        name: 'send',
        jobId: `reserved-${uniqueEmail('r')}`,
        payload: { secret: 'plain' },
      }),
    ).rejects.toThrow('reserved');
  });

  it('enqueues once when the same job id is asked for twice', async () => {
    const outbox = h.app.get(OutboxService);
    const request = {
      queue: QUEUE_NAMES.email,
      name: 'send',
      jobId: `dedupe-${uniqueEmail('x')}`,
      payload: {
        kind: 'magic_link',
        to: 'dedupe@example.com',
        link: 'http://localhost:3000/x',
        expiresInMinutes: 15,
      },
    } as const;
    expect(await outbox.enqueue(request)).toBe(true);
    expect(await outbox.enqueue(request)).toBe(false);
  });

  it('refuses a queue that does not exist and options nobody reviewed', async () => {
    const outbox = h.app.get(OutboxService);
    await expect(
      outbox.enqueue({
        queue: 'nope' as typeof QUEUE_NAMES.email,
        name: 'send',
        jobId: 'a',
        payload: {},
      }),
    ).rejects.toThrow('unknown queue');
    await expect(
      outbox.enqueue({
        queue: QUEUE_NAMES.email,
        name: 'send',
        jobId: 'b',
        payload: {},
        options: { repeat: { every: 1 } } as never,
      }),
    ).rejects.toThrow();
  });

  it('writes the row in the same transaction as the token, so both exist or neither does', async () => {
    const email = await createClient();
    await requestLink(email);
    const tokens = await pool().query(
      `SELECT 1 FROM magic_link_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1`,
      [email],
    );
    expect(tokens.rowCount).toBe(1);
    expect(await outboxRowFor(email)).toHaveLength(1);
  });
});
