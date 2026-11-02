import { AUDIT_ACTIONS, type GmailManualSyncResult } from '@watchtower/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type ApiErrorBody } from '../testing/ticketing.js';

// T-150: a head syncs the Gmail mailbox by hand. Real Postgres and Redis; nothing reaches Google
// (the API only queues the job, the worker would read history).

const SYNC = '/v1/admin/integrations/gmail/sync';
let h: Harness;
const owner = () => h.db.owner.pool;

async function mailbox(address: string, enabled = true): Promise<string> {
  const account = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', $1) RETURNING id`,
    [address],
  );
  const id = account.rows[0]?.id ?? '';
  await owner().query(
    `INSERT INTO gmail_account_state (channel_account_id, email_address, enabled) VALUES ($1, $2, $3)`,
    [id, address, enabled],
  );
  return id;
}

async function queuedJobs() {
  const rows = await owner().query<{
    job_name: string;
    job_id: string;
    payload: { channelAccountId: string; reason: string };
  }>(`SELECT job_name, job_id, payload FROM outbox WHERE queue = 'gmail' ORDER BY created_at`);
  return rows.rows;
}

beforeAll(async () => {
  h = await startHarness({});
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await owner().query(`DELETE FROM outbox WHERE queue = 'gmail'`);
  await owner().query(`DELETE FROM channel_account WHERE type = 'gmail'`);
});

describe('POST /v1/admin/integrations/gmail/sync', () => {
  it('is for the head only: lead, agent and client get 403, no session 401, nothing queued', async () => {
    await mailbox('a@example.test');
    const lead = await signIn(h, 'lead');
    const agent = await signIn(h, 'agent');
    const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Sync' });
    const client = await signIn(h, 'client', org.body.id);
    for (const who of [lead, agent, client]) {
      expect((await who.client.post(SYNC, {})).status, who.session.user.role).toBe(403);
    }
    expect((await h.client().request('POST', SYNC, { body: {}, csrf: false })).status).toBe(401);
    expect(await queuedJobs()).toEqual([]);
  });

  it('queues a manual sync for each enabled mailbox, skips disabled ones, and audits it', async () => {
    const one = await mailbox('one@example.test');
    const two = await mailbox('two@example.test');
    await mailbox('off@example.test', false);
    const head = await signIn(h, 'head');

    const response = await head.client.post<GmailManualSyncResult>(SYNC, {});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.throttled).toEqual([]);
    expect(response.body.queued.map((q) => q.channelAccountId).sort()).toEqual([one, two].sort());

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.job_name).toBe('sync');
      expect(job.payload.reason).toBe('manual');
      expect([one, two]).toContain(job.payload.channelAccountId);
    }
    expect(response.body.queued.map((q) => q.jobId).sort()).toEqual(
      jobs.map((job) => job.job_id).sort(),
    );

    const audit = await owner().query<{ actor_id: string; outcome: string; metadata: unknown }>(
      `SELECT actor_id, outcome, metadata FROM audit_log WHERE action = $1`,
      [AUDIT_ACTIONS.gmailManualSync],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(head.session.user.id);
    expect(audit.rows[0]?.outcome).toBe('success');
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('example.test');
  });

  it('allows one sync per mailbox per minute: the repeat is 429 with Retry-After and queues nothing', async () => {
    await mailbox('rate@example.test');
    const head = await signIn(h, 'head');
    expect((await head.client.post(SYNC, {})).status).toBe(200);
    const again = await head.client.post<ApiErrorBody>(SYNC, {});
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('queues the mailbox that is free and reports the throttled one', async () => {
    const first = await mailbox('first@example.test');
    const head = await signIn(h, 'head');
    expect((await head.client.post(SYNC, {})).status).toBe(200);
    const second = await mailbox('second@example.test');
    const response = await head.client.post<GmailManualSyncResult>(SYNC, {});
    expect(response.status).toBe(200);
    expect(response.body.queued.map((q) => q.channelAccountId)).toEqual([second]);
    expect(response.body.throttled.map((t) => t.channelAccountId)).toEqual([first]);
    expect(response.body.throttled[0]?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('answers 409 when no enabled mailbox exists', async () => {
    await mailbox('off@example.test', false);
    const head = await signIn(h, 'head');
    const response = await head.client.post<ApiErrorBody>(SYNC, {});
    expect(response.status).toBe(409);
    expect(await queuedJobs()).toEqual([]);
  });
});
