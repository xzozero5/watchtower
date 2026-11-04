import { randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  PORTAL_PROOF_HEADER,
  encodePortalProof,
  type HumanChallenge,
  type PortalSubmitted,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { type ApiErrorBody } from '../testing/ticketing.js';
import { solveChallenge } from './pow.js';

// T-155a C-1 (upload quotas per address, email and organization, with the instance-wide cap as a
// backstop, atomic in Redis) and T-154 (the upload slot cannot be held by a slow sender or by a request
// without a proof), against the real application, Postgres and Redis.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A file of about 600 KB that passes the content check. */
const big = () => Buffer.concat([PNG_HEAD, randomBytes(600 * 1024)]);
const DOMAIN = 'quota-acme.example';

async function proofOf(client: TestClient) {
  const response = await client.get<HumanChallenge>('/v1/portal/challenge');
  expect(response.status).toBe(200);
  return {
    provider: 'pow-sha256' as const,
    challenge: response.body.challenge,
    nonce: solveChallenge(response.body.challenge, response.body.difficultyBits),
  };
}

async function submit(
  client: TestClient,
  files: readonly Buffer[],
  fields: Record<string, unknown> = {},
  withHeader = true,
) {
  const verification = await proofOf(client);
  const payload = {
    email: uniqueEmail('customer', DOMAIN),
    name: 'Nok Customer',
    category: 'api_error',
    description: 'Webhook deliveries stopped at 09:00, screenshot attached.',
    verification,
    ...fields,
  };
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const [index, bytes] of files.entries()) {
    form.append('files', new Blob([Buffer.from(bytes)]), `shot-${String(index)}.png`);
  }
  const response = await client.post<PortalSubmitted & ApiErrorBody>('/v1/portal/tickets', form, {
    headers: withHeader ? { [PORTAL_PROOF_HEADER]: encodePortalProof(verification) } : {},
  });
  return { response, payload };
}

async function auditReasons(h: Harness): Promise<string[]> {
  const rows = await h.db.owner.pool.query<{ reason: string | null }>(
    `SELECT metadata ->> 'reason' AS reason FROM audit_log WHERE action = 'portal.attachment_rejected'`,
  );
  return rows.rows.map((row) => row.reason ?? '');
}

describe('upload quotas (C-1)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      env: {
        PORTAL_POW_DIFFICULTY_BITS: '8',
        PORTAL_MIN_FILL_SECONDS: '0',
        PORTAL_UPLOAD_MAX_CONCURRENT: '12',
        PORTAL_UPLOAD_MAX_PER_ADDRESS: '10',
        PORTAL_RATE_IP_PER_HOUR: '1000',
        PORTAL_RATE_EMAIL_PER_HOUR: '1000',
        PORTAL_RATE_ORG_PER_HOUR: '1000',
        PORTAL_UPLOAD_IP_DAILY_MB: '1',
        PORTAL_UPLOAD_EMAIL_DAILY_MB: '100',
        PORTAL_UPLOAD_ORG_DAILY_MB: '100',
        PORTAL_UPLOAD_DAILY_MB: '100',
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('stops one address at its own cap and leaves every other customer able to attach files', async () => {
    const outsider = h.client();
    expect((await submit(outsider, [big()])).response.status).toBe(201);
    const refused = await submit(outsider, [big()]);
    expect(refused.response.status).toBe(429);
    expect(refused.response.body.code).toBe('upload_quota');
    // Somebody else, from another address, is not affected (the old single cap would have been).
    expect((await submit(h.client(), [big()])).response.status).toBe(201);
    expect(await auditReasons(h)).toContain('upload_quota');
  });

  it('counts atomically: parallel requests cannot all slip under one cap', async () => {
    const client = h.client();
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(client, [big()])));
    const statuses = results.map((result) => result.response.status);
    // 1 MB cap, 600 KB each: exactly one fits whatever the interleaving.
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  it('does not hold any of the allowance for a file that is refused', async () => {
    const client = h.client();
    const bad = await submit(client, [Buffer.from('<html><script>alert(1)</script></html>')]);
    expect(bad.response.status).toBe(400);
    expect((await submit(client, [big()])).response.status).toBe(201);
  });
});

describe('the instance-wide cap is only a backstop (C-1)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      env: {
        PORTAL_POW_DIFFICULTY_BITS: '8',
        PORTAL_MIN_FILL_SECONDS: '0',
        PORTAL_RATE_IP_PER_HOUR: '1000',
        PORTAL_RATE_EMAIL_PER_HOUR: '1000',
        PORTAL_RATE_ORG_PER_HOUR: '1000',
        PORTAL_UPLOAD_IP_DAILY_MB: '0',
        PORTAL_UPLOAD_EMAIL_DAILY_MB: '1',
        PORTAL_UPLOAD_ORG_DAILY_MB: '0',
        PORTAL_UPLOAD_DAILY_MB: '2',
      },
    });
    await h.db.owner.pool.query(
      `INSERT INTO users (email, name, role) VALUES ('head-quota@example.test', 'Head', 'head')`,
    );
  });
  afterAll(async () => {
    await h.close();
  });

  it('caps one email address on its own', async () => {
    const email = uniqueEmail('customer', DOMAIN);
    expect((await submit(h.client(), [big()], { email })).response.status).toBe(201);
    const second = await submit(h.client(), [big()], { email });
    expect(second.response.status).toBe(429);
    expect(second.response.body.code).toBe('upload_quota');
  });

  it('audits, logs the alert once and counts it when the instance-wide cap is reached', async () => {
    // 600 KB already used by the test above; two more from other addresses fill the 2 MB.
    expect((await submit(h.client(), [big()])).response.status).toBe(201);
    expect((await submit(h.client(), [big()])).response.status).toBe(201);
    const full = await submit(h.client(), [big()]);
    expect(full.response.status).toBe(429);
    expect(full.response.body.code).toBe('upload_quota');
    expect(await auditReasons(h)).toContain('upload_quota_global');
    const metrics = await (await fetch(`${h.base}/metrics`)).text();
    expect(metrics).toMatch(/portal_upload_quota_global_total\S* [1-9]/);
  });

  it('tells the head in the app, once, when the instance-wide cap is reached (T-176)', async () => {
    // The test above filled the cap; two more refused uploads must not make a second notice.
    expect((await submit(h.client(), [big()])).response.status).toBe(429);
    expect((await submit(h.client(), [big()])).response.status).toBe(429);
    const { rows } = await h.db.owner.pool.query<{ kind: string; severity: string }>(
      `SELECT n.kind, n.severity FROM notification n JOIN users u ON u.id = n.user_id
        WHERE u.email = 'head-quota@example.test'`,
    );
    expect(rows).toEqual([{ kind: 'ops.upload_quota_global', severity: 'high' }]);
  });
});

describe('the upload slot (T-154)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      env: {
        PORTAL_POW_DIFFICULTY_BITS: '8',
        PORTAL_MIN_FILL_SECONDS: '0',
        PORTAL_UPLOAD_IDLE_SECONDS: '2',
        PORTAL_UPLOAD_MIN_KB_PER_SECOND: '64',
        PORTAL_UPLOAD_PROOF_HEADER: 'required',
        PORTAL_UPLOAD_MAX_CONCURRENT: '1',
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  /** A multipart request that announces 5 MB and sends the start of it. */
  function stalled(ip: string, headers: Record<string, string>) {
    const request = http.request(new URL('/v1/portal/tickets', h.base), {
      method: 'POST',
      headers: {
        'x-forwarded-for': ip,
        origin: new URL(h.config.APP_URL).origin,
        'content-type': 'multipart/form-data; boundary=wtboundary',
        'content-length': String(5 * 1024 * 1024),
        ...headers,
      },
    });
    const closed = new Promise<void>((resolve) => {
      request.on('close', () => {
        resolve();
      });
    });
    const answer = new Promise<number>((resolve) => {
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    request.on('error', () => undefined);
    request.write('--wtboundary\r\nContent-Disposition: form-data; name="payload"\r\n\r\n{');
    return { request, closed, answer };
  }
  const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('turns a submit without a proof away before it takes the slot', async () => {
    const noProof = stalled('10.40.0.1', {});
    // Answered from the headers alone, with the body still unsent.
    expect(await Promise.race([noProof.answer, settle(3000).then(() => 0)])).toBe(400);
    noProof.request.destroy();
    const garbage = stalled('10.40.0.2', { [PORTAL_PROOF_HEADER]: 'not-a-proof' });
    expect(await Promise.race([garbage.answer, settle(3000).then(() => 0)])).toBe(400);
    garbage.request.destroy();
    // The only slot is still free: a request with a proof gets it.
    const proof = encodePortalProof(await proofOf(h.client()));
    const holder = stalled('10.40.0.3', { [PORTAL_PROOF_HEADER]: proof });
    await settle(300);
    const reasons = await h.db.owner.pool.query<{ reason: string }>(
      `SELECT metadata ->> 'reason' AS reason FROM audit_log WHERE action = 'portal.verification_failed'`,
    );
    expect(reasons.rows.map((row) => row.reason)).toEqual(
      expect.arrayContaining(['missing', 'malformed']),
    );
    holder.request.destroy();
    await holder.closed;
  });

  it('counts a request turned away for lack of a slot, for an alert', async () => {
    const proof = encodePortalProof(await proofOf(h.client()));
    const holder = stalled('10.41.0.1', { [PORTAL_PROOF_HEADER]: proof });
    await settle(300);
    const other = stalled('10.41.0.2', {
      [PORTAL_PROOF_HEADER]: encodePortalProof(await proofOf(h.client())),
    });
    expect(await Promise.race([other.answer, settle(3000).then(() => 0)])).toBe(503);
    other.request.destroy();
    holder.request.destroy();
    await holder.closed;
    const metrics = await (await fetch(`${h.base}/metrics`)).text();
    expect(metrics).toMatch(/portal_upload_busy_total\S* [1-9]/);
  });

  it('cuts off a sender that trickles a byte at a time, sooner than the old fixed deadline', async () => {
    const proof = encodePortalProof(await proofOf(h.client()));
    const trickle = stalled('10.42.0.1', { [PORTAL_PROOF_HEADER]: proof });
    const started = Date.now();
    // Never silent for 2 seconds, so the idle timeout does not fire; only the minimum speed can.
    const timer = setInterval(() => {
      trickle.request.write('x');
    }, 300);
    await Promise.race([trickle.closed, settle(12_000)]);
    clearInterval(timer);
    const took = Date.now() - started;
    expect(took).toBeLessThan(6500); // the fixed deadline was 4 idle periods = 8 s
    // The slot is back.
    await settle(300);
    const next = stalled('10.42.0.2', {
      [PORTAL_PROOF_HEADER]: encodePortalProof(await proofOf(h.client())),
    });
    await settle(300);
    expect(next.request.destroyed).toBe(false);
    next.request.destroy();
    await next.closed;
  }, 30_000);
});
