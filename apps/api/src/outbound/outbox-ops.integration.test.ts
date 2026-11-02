import { randomUUID } from 'node:crypto';

import type {
  CancelSendResult,
  DeadOutboxItem,
  Message,
  OutboxHealth,
  ResendOutboxResult,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueFakeInbound } from '../inbound/fake-channel.js';
import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-121a: the head's view of the outbox: health (backlog and the age of the oldest waiting job),
// the dead-letter list, and resend. The relay and the worker are not running; rows are written the
// way the relay leaves them. Nothing leaves the machine.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let gmailId: string;
let orgId: string;

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Outbox Org' })).id;
  client = await signIn(h, 'client', orgId);
  const account = await pool().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Ops mailbox') RETURNING id`,
  );
  gmailId = account.rows[0]?.id ?? '';
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

/** A row the way the relay leaves a given-up job: dead, payload blanked. */
async function deadRow(fields: {
  queue: string;
  jobName: string;
  jobId: string;
  lastError?: string;
}): Promise<string> {
  const result = await pool().query<{ id: string }>(
    `INSERT INTO outbox (queue, job_name, job_id, payload, status, attempts, last_error, finished_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'dead', 30, $4, now()) RETURNING id`,
    [fields.queue, fields.jobName, fields.jobId, fields.lastError ?? 'ConnectionError: redis down'],
  );
  return result.rows[0]?.id ?? '';
}

async function pendingRow(secondsAgo: number): Promise<string> {
  const result = await pool().query<{ id: string }>(
    `INSERT INTO outbox (queue, job_name, job_id, payload, status, next_attempt_at)
     VALUES ('email', 'send', $1, '{}'::jsonb, 'pending', now() - make_interval(secs => $2))
     RETURNING id`,
    [`pending-${randomUUID()}`, secondsAgo],
  );
  return result.rows[0]?.id ?? '';
}

const clearOutbox = () => pool().query('DELETE FROM outbox');

describe('who may see the outbox', () => {
  it('is for the head: others get 403, nobody signed in gets 401', async () => {
    for (const path of ['/v1/ops/outbox', '/v1/ops/outbox/dead']) {
      expect((await head.client.get(path)).status).toBe(200);
      expect((await lead.client.get(path)).status).toBe(403);
      expect((await agent.client.get(path)).status).toBe(403);
      expect((await client.client.get(path)).status).toBe(403);
      expect((await h.client().get(path)).status).toBe(401);
    }
    const id = randomUUID();
    expect((await lead.client.post(`/v1/ops/outbox/${id}/resend`, {})).status).toBe(403);
    expect((await agent.client.post(`/v1/ops/outbox/${id}/resend`, {})).status).toBe(403);
    expect((await client.client.post(`/v1/ops/outbox/${id}/resend`, {})).status).toBe(403);
    expect((await h.client().post(`/v1/ops/outbox/${id}/resend`, {})).status).toBe(401);
  });
});

describe('GET /v1/ops/outbox (health)', () => {
  it('is ok and empty when nothing waits', async () => {
    await clearOutbox();
    const response = await head.client.get<OutboxHealth>('/v1/ops/outbox');
    expect(response.body).toMatchObject({
      pending: 0,
      dead: 0,
      oldestPendingSeconds: 0,
      status: 'ok',
      byQueue: [],
    });
  });

  it('measures the age of the oldest pending row that was due, and ignores one held back on purpose', async () => {
    await clearOutbox();
    await pendingRow(30);
    await pendingRow(200);
    // Held back (an undo window): not late until its time comes.
    await pool().query(
      `INSERT INTO outbox (queue, job_name, job_id, payload, next_attempt_at)
       VALUES ('outbound', 'dispatch', 'held-1', '{}'::jsonb, now() + interval '1 hour')`,
    );
    await deadRow({ queue: 'email', jobName: 'send', jobId: 'dead-1' });
    const response = await head.client.get<OutboxHealth>('/v1/ops/outbox');
    expect(response.body.pending).toBe(3);
    expect(response.body.dead).toBe(1);
    expect(response.body.oldestPendingSeconds).toBeGreaterThanOrEqual(199);
    expect(response.body.oldestPendingSeconds).toBeLessThan(230);
    expect(response.body.status).toBe('warning');
    expect(response.body.byQueue).toEqual([
      { queue: 'email', pending: 2, dead: 1 },
      { queue: 'outbound', pending: 1, dead: 0 },
    ]);
  });

  it('turns critical after ten minutes', async () => {
    await clearOutbox();
    await pendingRow(11 * 60);
    const response = await head.client.get<OutboxHealth>('/v1/ops/outbox');
    expect(response.body.status).toBe('critical');
    expect(response.body.oldestPendingSeconds).toBeGreaterThanOrEqual(660);
  });
});

describe('GET /v1/ops/outbox/dead', () => {
  it('lists dead rows only, newest first, without any payload', async () => {
    await clearOutbox();
    await pendingRow(5);
    await pool().query(
      `INSERT INTO outbox (queue, job_name, job_id, payload, status, finished_at)
       VALUES ('email', 'send', 'sent-1', '{}'::jsonb, 'sent', now())`,
    );
    const older = await deadRow({ queue: 'email', jobName: 'send', jobId: 'dead-older' });
    await pool().query(`UPDATE outbox SET finished_at = now() - interval '1 hour' WHERE id = $1`, [
      older,
    ]);
    const newer = await deadRow({ queue: 'email', jobName: 'send', jobId: 'dead-newer' });

    const response = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual([newer, older]);
    for (const item of response.body.items) {
      expect(Object.keys(item)).not.toContain('payload');
      expect(item).toMatchObject({
        queue: 'email',
        attempts: 30,
        lastError: 'ConnectionError: redis down',
        replayable: false,
      });
      expect(item.notReplayableReason).toContain('no source record');
      expect(item.effect).toBeNull();
    }

    const filtered = await head.client.get<Page<DeadOutboxItem>>(
      '/v1/ops/outbox/dead?queue=ingest',
    );
    expect(filtered.body.items).toEqual([]);
  });

  it('pages with a cursor', async () => {
    await clearOutbox();
    for (const index of [1, 2, 3]) {
      const id = await deadRow({ queue: 'email', jobName: 'send', jobId: `page-${String(index)}` });
      await pool().query(
        `UPDATE outbox SET finished_at = now() - make_interval(mins => $2) WHERE id = $1`,
        [id, index],
      );
    }
    const first = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead?limit=2');
    expect(first.body.items.map((item) => item.jobId)).toEqual(['page-1', 'page-2']);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await head.client.get<Page<DeadOutboxItem>>(
      `/v1/ops/outbox/dead?limit=2&cursor=${first.body.nextCursor ?? ''}`,
    );
    expect(second.body.items.map((item) => item.jobId)).toEqual(['page-3']);
    expect(second.body.nextCursor).toBeNull();
    expect((await head.client.get('/v1/ops/outbox/dead?cursor=nonsense')).status).toBe(400);
  });
});

describe('POST /v1/ops/outbox/:id/resend', () => {
  it('rebuilds an ingest job from its received event, with a fresh job id, and audits it', async () => {
    await clearOutbox();
    const queued = await enqueueFakeInbound(h.db.owner, {
      channel: 'gmail',
      from: 'someone@customer.example.test',
      subject: 'Please help',
      body: 'It does not work.',
    });
    // The relay gave up on it: dead and blanked.
    await pool().query(
      `UPDATE outbox SET status = 'dead', payload = '{}'::jsonb, attempts = 30, finished_at = now(),
              last_error = 'gave up' WHERE job_id = $1`,
      [queued.inboundEventId],
    );
    const [row] = (
      await pool().query<{ id: string }>(`SELECT id FROM outbox WHERE job_id = $1`, [
        queued.inboundEventId,
      ])
    ).rows;

    const listed = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(listed.body.items[0]).toMatchObject({ id: row?.id, replayable: true });
    // The head is told a resend processes a received event for the first time; Gmail sends nothing back.
    expect(listed.body.items[0]?.effect).toEqual({
      kind: 'reprocess_inbound',
      channel: 'gmail',
      channelAccountName: expect.any(String) as string,
      origin: null,
      ticketNumber: null,
      mayAcknowledge: false,
    });

    const response = await head.client.post<ResendOutboxResult>(
      `/v1/ops/outbox/${row?.id ?? ''}/resend`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: row?.id, queue: 'ingest', status: 'pending' });
    expect(response.body.jobId).toMatch(new RegExp(`^${queued.inboundEventId}-resend-`));

    const after = await pool().query<{
      status: string;
      payload: unknown;
      attempts: number;
      last_error: string | null;
      finished_at: Date | null;
      job_id: string;
    }>(
      `SELECT status, payload, attempts, last_error, finished_at, job_id FROM outbox WHERE id = $1`,
      [row?.id],
    );
    expect(after.rows[0]).toMatchObject({
      status: 'pending',
      payload: { inboundEventId: queued.inboundEventId },
      attempts: 0,
      last_error: null,
      finished_at: null,
      job_id: response.body.jobId,
    });

    const audit = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'outbox.resend' AND target_id = $1`,
      [row?.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(head.userId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      queue: 'ingest',
      previousJobId: queued.inboundEventId,
      jobId: response.body.jobId,
    });

    // It is pending now: a second resend is refused, and the row is not in the dead list.
    const again = await head.client.post<ApiErrorBody>(
      `/v1/ops/outbox/${row?.id ?? ''}/resend`,
      {},
    );
    expect(again.status).toBe(409);
    expect((await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead')).body.items).toEqual(
      [],
    );
  });

  it('puts a delivery trigger back only while the delivery still waits to be sent', async () => {
    await clearOutbox();
    const ticket = await fileTicket(agent, orgId);
    await pool().query(
      `UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`,
      [ticket.id, gmailId],
    );
    const first = await agent.client.post<{ message: Message }>(
      `/v1/tickets/${ticket.id}/replies`,
      {
        body: 'We are on it.',
      },
    );
    const deliveryId = first.body.message.delivery?.id ?? '';
    expect(deliveryId).not.toBe('');
    const [trigger] = (
      await pool().query<{ id: string; job_id: string; payload: unknown }>(
        `SELECT id, job_id, payload FROM outbox WHERE queue = 'outbound'`,
      )
    ).rows;
    expect(trigger?.payload).toEqual({ deliveryId });
    await pool().query(
      `UPDATE outbox SET status = 'dead', payload = '{}'::jsonb, finished_at = now() WHERE id = $1`,
      [trigger?.id],
    );

    const listed = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(listed.body.items[0]).toMatchObject({ id: trigger?.id, replayable: true });
    // A resend of a delivery says it may reach a customer, and where: channel, account and ticket,
    // never the message itself or an address.
    expect(listed.body.items[0]?.effect).toEqual({
      kind: 'customer_message',
      channel: 'gmail',
      channelAccountName: 'Ops mailbox',
      origin: expect.any(String) as string,
      ticketNumber: Number(ticket.key.split('-').at(-1)),
      mayAcknowledge: false,
    });
    expect(JSON.stringify(listed.body.items[0])).not.toContain('We are on it.');

    // Undo the send: the delivery is cancelled, so there is nothing left to trigger.
    const cancelled = await agent.client.post<CancelSendResult>(
      `/v1/tickets/${ticket.id}/deliveries/${deliveryId}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    const after = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(after.body.items[0]).toMatchObject({ id: trigger?.id, replayable: false });
    expect(after.body.items[0]?.notReplayableReason).toContain('cancelled');
    const refused = await head.client.post<ApiErrorBody>(
      `/v1/ops/outbox/${trigger?.id ?? ''}/resend`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('conflict');
  });

  it('rebuilds a delivery trigger with only the delivery id, as the dispatcher expects it', async () => {
    await clearOutbox();
    const ticket = await fileTicket(agent, orgId);
    await pool().query(
      `UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`,
      [ticket.id, gmailId],
    );
    const reply = await agent.client.post<{ message: Message }>(
      `/v1/tickets/${ticket.id}/replies`,
      {
        body: 'Second reply.',
      },
    );
    const deliveryId = reply.body.message.delivery?.id ?? '';
    await pool().query(
      `UPDATE outbox SET status = 'dead', payload = '{}'::jsonb, finished_at = now() WHERE queue = 'outbound'`,
    );
    const [row] = (
      await pool().query<{ id: string }>(`SELECT id FROM outbox WHERE queue = 'outbound'`)
    ).rows;
    const response = await head.client.post<ResendOutboxResult>(
      `/v1/ops/outbox/${row?.id ?? ''}/resend`,
      {},
    );
    expect(response.status).toBe(200);
    const [after] = (
      await pool().query<{ status: string; payload: unknown; options: unknown }>(
        `SELECT status, payload, options FROM outbox WHERE id = $1`,
        [row?.id],
      )
    ).rows;
    expect(after).toMatchObject({ status: 'pending', payload: { deliveryId } });
    // The job options survive, so retries behave as they did the first time.
    expect(after?.options).toMatchObject({ attempts: 3 });
    // Resending put nothing in front of a customer: the delivery is still waiting for the dispatcher.
    const state = await pool().query<{ state: string }>(
      `SELECT state FROM outbound_delivery WHERE id = $1`,
      [deliveryId],
    );
    expect(state.rows[0]?.state).toBe('scheduled');
  });

  it('says a LINE message may be acknowledged to the customer by the same job', async () => {
    await clearOutbox();
    const queued = await enqueueFakeInbound(h.db.owner, {
      channel: 'line',
      userId: 'U-outbox-line',
      text: 'Hello',
    });
    await pool().query(
      `UPDATE outbox SET status = 'dead', payload = '{}'::jsonb, finished_at = now() WHERE job_id = $1`,
      [queued.inboundEventId],
    );
    const listed = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(listed.body.items[0]).toMatchObject({ replayable: true });
    expect(listed.body.items[0]?.effect).toMatchObject({
      kind: 'reprocess_inbound',
      channel: 'line',
      mayAcknowledge: true,
    });
  });

  it('does not offer a resend for a received event that failed: the consumer would skip it', async () => {
    await clearOutbox();
    const queued = await enqueueFakeInbound(h.db.owner, {
      channel: 'gmail',
      from: 'someone-else@customer.example.test',
      subject: 'Failed one',
      body: 'It does not work.',
    });
    await pool().query(`UPDATE inbound_event SET status = 'failed' WHERE id = $1`, [
      queued.inboundEventId,
    ]);
    await pool().query(
      `UPDATE outbox SET status = 'dead', payload = '{}'::jsonb, finished_at = now() WHERE job_id = $1`,
      [queued.inboundEventId],
    );
    const [row] = (
      await pool().query<{ id: string }>(`SELECT id FROM outbox WHERE job_id = $1`, [
        queued.inboundEventId,
      ])
    ).rows;
    const listed = await head.client.get<Page<DeadOutboxItem>>('/v1/ops/outbox/dead');
    expect(listed.body.items[0]).toMatchObject({ id: row?.id, replayable: false, effect: null });
    expect(listed.body.items[0]?.notReplayableReason).toContain('failed');
    const refused = await head.client.post<ApiErrorBody>(
      `/v1/ops/outbox/${row?.id ?? ''}/resend`,
      {},
    );
    expect(refused.status).toBe(409);
    // The row is still there for the head to see.
    const status = await pool().query<{ status: string }>(
      `SELECT status FROM outbox WHERE id = $1`,
      [row?.id],
    );
    expect(status.rows[0]?.status).toBe('dead');
  });

  it('refuses a row that cannot be rebuilt (409), one that is not dead (409) and one that does not exist (404)', async () => {
    await clearOutbox();
    const email = await deadRow({ queue: 'email', jobName: 'send', jobId: 'dead-email' });
    const refused = await head.client.post<ApiErrorBody>(`/v1/ops/outbox/${email}/resend`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('no source record');
    // Still dead afterwards, and nothing was written to the audit log as a success.
    const status = await pool().query<{ status: string }>(
      `SELECT status FROM outbox WHERE id = $1`,
      [email],
    );
    expect(status.rows[0]?.status).toBe('dead');
    const failed = await pool().query<{ outcome: string }>(
      `SELECT outcome FROM audit_log WHERE action = 'outbox.resend' AND target_id = $1`,
      [email],
    );
    expect(failed.rows.map((row) => row.outcome)).toEqual(['failure']);

    const pending = await pendingRow(5);
    expect((await head.client.post(`/v1/ops/outbox/${pending}/resend`, {})).status).toBe(409);
    expect((await head.client.post(`/v1/ops/outbox/${randomUUID()}/resend`, {})).status).toBe(404);
    expect((await head.client.post('/v1/ops/outbox/not-a-uuid/resend', {})).status).toBe(400);
  });
});
