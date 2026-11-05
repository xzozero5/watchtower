import { randomUUID } from 'node:crypto';

import {
  type CancelSendResult,
  type DeliverySummary,
  type Message,
  type OutboundSettings,
  type TimelineEntry,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

// Undo send, the delivery state on messages, the AI-draft binding and the instance setting, on the
// real application. The worker is not running: these tests look at what the api promises (the
// delivery row and its window); the dispatcher has its own tests in apps/worker. Nothing leaves the
// machine.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let agent2: Persona;
let orgId: string;
let gmailId: string;

const pool = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  agent2 = await signIn(h, 'agent', undefined, 'Agent Two');
  orgId = (await apiOrg(lead, { name: 'Acme Outbound' })).id;
  const account = await pool().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support mailbox') RETURNING id`,
  );
  gmailId = account.rows[0]?.id ?? '';
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function gmailTicket(fields: Record<string, unknown> = {}): Promise<string> {
  const ticket = await fileTicket(agent, orgId, fields);
  await pool().query(`UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`, [
    ticket.id,
    gmailId,
  ]);
  return ticket.id;
}

async function reply(
  who: Persona,
  ticketId: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  return who.client.post<{ message: Message }>(`/v1/tickets/${ticketId}/replies`, {
    body,
    ...extra,
  });
}

const cancel = (who: Persona, ticketId: string, deliveryId: string) =>
  who.client.post<CancelSendResult & Partial<ApiErrorBody>>(
    `/v1/tickets/${ticketId}/deliveries/${deliveryId}/cancel`,
    {},
  );

function deliveryOf(response: { body: { message: Message } }): DeliverySummary {
  const delivery = response.body.message.delivery;
  if (delivery === null || delivery === undefined) throw new Error('no delivery in the response');
  return delivery;
}

type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;
const messagesOf = async (who: Persona, ticketId: string): Promise<MessageEntry[]> =>
  (await timelineOf(who, ticketId)).entries.filter(
    (entry): entry is MessageEntry => entry.kind === 'message',
  );

describe('replying on Gmail', () => {
  it('queues the reply for the undo window and says so', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'We are looking into it.');
    expect(response.status).toBe(201);
    expect(response.body.message.deliveryStatus).toBe('scheduled');
    const delivery = deliveryOf(response);
    expect(delivery).toMatchObject({
      state: 'scheduled',
      origin: 'human',
      channel: 'gmail',
      attempts: 0,
      cancellable: true,
      errorCode: null,
    });
    // The hold is what was scheduled, read off the row (both stamps come from the same database clock). It
    // is not measured against this process' clock: that runs apart from the database's under Docker
    // Desktop (+600 ms measured, so a 5 s hold read as 5450 ms) and stretches with the load of the run.
    const scheduled = await pool().query<{ hold_seconds: number; hold_ms: number }>(
      `SELECT hold_seconds, (extract(epoch FROM next_attempt_at - created_at) * 1000)::int AS hold_ms
         FROM outbound_delivery WHERE id = $1`,
      [delivery.id],
    );
    expect(scheduled.rows[0]).toEqual({ hold_seconds: 5, hold_ms: 5_000 });

    // Staff see the delivery in the timeline; the first response is not counted yet.
    const [outbound] = (await messagesOf(agent, ticketId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound?.delivery).toMatchObject({ id: delivery.id, state: 'scheduled' });
    const detail = await agent.client.get<{ firstRespondedAt: string | null }>(
      `/v1/tickets/${ticketId}`,
    );
    expect(detail.body.firstRespondedAt).toBeNull();
  });

  it('keeps an unsent reply out of what the customer sees, and shows it once it has gone', async () => {
    const { clientOfNewOrg } = await import('../testing/ticketing.js');
    const mine = await clientOfNewOrg(h);
    const created = await mine.persona.client.post<{ id: string }>('/v1/tickets', {
      subject: 'Reports are empty',
      body: 'Nothing shows up.',
    });
    expect(created.status).toBe(201);
    await pool().query(
      `UPDATE ticket SET channel = 'gmail', channel_account_id = $2 WHERE id = $1`,
      [created.body.id, gmailId],
    );
    const sent = await reply(agent, created.body.id, 'Looking now.');
    const visibleToClient = async () =>
      (await messagesOf(mine.persona, created.body.id)).filter((m) => m.direction === 'outbound');

    expect(await visibleToClient()).toHaveLength(0);
    expect(
      (await messagesOf(agent, created.body.id)).filter((m) => m.direction === 'outbound'),
    ).toHaveLength(1);

    // The customer never gets the delivery object, the hash or the state, only a delivered message.
    await pool().query(`UPDATE message SET delivery_status = 'delivered' WHERE id = $1`, [
      sent.body.message.id,
    ]);
    const after = await visibleToClient();
    expect(after).toHaveLength(1);
    expect(after[0]?.delivery ?? null).toBeNull();
    expect(JSON.stringify(after[0])).not.toMatch(/contentHash|content_hash|rfc822|outcome/i);
  });

  it('shows a cancelled reply to staff only, and never to the customer', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Oops wrong ticket');
    const undone = await cancel(agent, ticketId, deliveryOf(response).id);
    expect(undone.status).toBe(200);
    const [outbound] = (await messagesOf(agent, ticketId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toMatchObject({
      deliveryStatus: 'cancelled',
      delivery: { state: 'cancelled' },
    });
  });
});

describe('POST /v1/tickets/:id/deliveries/:deliveryId/cancel', () => {
  it('undoes a send inside the window, audits it, and can be asked twice', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Undo this');
    const deliveryId = deliveryOf(response).id;

    const first = await cancel(agent, ticketId, deliveryId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      messageId: response.body.message.id,
      deliveryStatus: 'cancelled',
      delivery: { id: deliveryId, state: 'cancelled', cancellable: false },
    });
    const again = await cancel(agent, ticketId, deliveryId);
    expect(again.status).toBe(200);

    const audit = await pool().query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'outbound.cancelled' AND target_id = $1`,
      [deliveryId],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
    // The row is cancelled in the database too, and the trigger will find nothing to send.
    const row = await pool().query<{ state: string; cancelled_by: string }>(
      `SELECT state, cancelled_by FROM outbound_delivery WHERE id = $1`,
      [deliveryId],
    );
    expect(row.rows[0]).toMatchObject({ state: 'cancelled', cancelled_by: agent.userId });
  });

  it('answers 409 once the window has ended', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Too late');
    const deliveryId = deliveryOf(response).id;
    await pool().query(
      `UPDATE outbound_delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [deliveryId],
    );
    const late = await cancel(agent, ticketId, deliveryId);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('conflict');
    const row = await pool().query<{ state: string }>(
      `SELECT state FROM outbound_delivery WHERE id = $1`,
      [deliveryId],
    );
    expect(row.rows[0]?.state).toBe('scheduled');
  });

  it('answers 409 when the message is being sent or has gone', async () => {
    for (const state of ['sending', 'sent'] as const) {
      const ticketId = await gmailTicket();
      const response = await reply(agent, ticketId, `State ${state}`);
      const deliveryId = deliveryOf(response).id;
      // A claim, then (for `sent`) the provider's answer: the database allows no shortcut.
      await pool().query(
        `UPDATE outbound_delivery
            SET state = 'sending', claim_token = gen_random_uuid(), attempts = 1,
                lease_until = now() + interval '1 minute'
          WHERE id = $1`,
        [deliveryId],
      );
      if (state === 'sent') {
        await pool().query(
          `UPDATE outbound_delivery SET state = 'sent', sent_at = now(), lease_until = NULL WHERE id = $1`,
          [deliveryId],
        );
      }
      const late = await cancel(agent, ticketId, deliveryId);
      expect(late.status, state).toBe(409);
    }
  });

  it('is for the sender, a lead or the head; a client and the unauthenticated cannot', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Mine');
    const deliveryId = deliveryOf(response).id;
    const denied = await cancel(agent2, ticketId, deliveryId);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');

    const { clientOfNewOrg } = await import('../testing/ticketing.js');
    const client = await clientOfNewOrg(h);
    expect((await cancel(client.persona, ticketId, deliveryId)).status).toBe(403);
    expect(
      (await h.client().post(`/v1/tickets/${ticketId}/deliveries/${deliveryId}/cancel`, {})).status,
    ).toBe(401);

    expect((await cancel(lead, ticketId, deliveryId)).status).toBe(200);
    const other = await reply(agent, await gmailTicket(), 'Mine too');
    expect((await cancel(head, other.body.message.ticketId, deliveryOf(other).id)).status).toBe(
      200,
    );
  });

  it('answers 404 for a delivery of another ticket or one that does not exist, and 400 for a bad id', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Elsewhere');
    const deliveryId = deliveryOf(response).id;
    const otherTicket = await gmailTicket();
    expect((await cancel(lead, otherTicket, deliveryId)).status).toBe(404);
    expect((await cancel(lead, ticketId, randomUUID())).status).toBe(404);
    expect((await cancel(lead, ticketId, 'not-a-uuid')).status).toBe(400);
  });
});

describe("who may undo a colleague's send (N-4)", () => {
  // Through the head's endpoint, as a deployment would: it also drops the permission cache.
  async function setRole(role: string, change: (current: string[]) => string[]): Promise<void> {
    const roles = await head.client.get<{ roles: { role: string; permissions: string[] }[] }>(
      '/v1/rbac/roles',
    );
    const current = roles.body.roles.find((entry) => entry.role === role)?.permissions ?? [];
    const put = await head.client.put(`/v1/rbac/roles/${role}/permissions`, {
      permissions: change(current),
    });
    expect(put.status).toBe(200);
  }
  const grant = (role: string, permission: string) =>
    setRole(role, (current) => [...new Set([...current, permission])]);
  const revoke = (role: string, permission: string) =>
    setRole(role, (current) => current.filter((key) => key !== permission));

  it('follows the permission, not the role name: a lead without it cannot, an agent with it can', async () => {
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Mine, not yours');
    const deliveryId = deliveryOf(response).id;

    await revoke('lead', 'ticket.cancel.any');
    try {
      const denied = await cancel(lead, ticketId, deliveryId);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('forbidden');
      // An agent holding it can undo a colleague's send.
      await grant('agent', 'ticket.cancel.any');
      const undone = await cancel(agent2, ticketId, deliveryId);
      expect(undone.status).toBe(200);
      expect(undone.body.deliveryStatus).toBe('cancelled');
    } finally {
      await revoke('agent', 'ticket.cancel.any');
      await grant('lead', 'ticket.cancel.any');
    }
    // Back to the defaults: the lead may, the other agent may not.
    const next = await reply(agent, await gmailTicket(), 'Mine again');
    const nextTicket = next.body.message.ticketId;
    expect((await cancel(agent2, nextTicket, deliveryOf(next).id)).status).toBe(403);
    expect((await cancel(lead, nextTicket, deliveryOf(next).id)).status).toBe(200);
  });

  it('never lets somebody scoped to an organization undo a send, even with the reply permission', async () => {
    const { clientOfNewOrg } = await import('../testing/ticketing.js');
    const mine = await clientOfNewOrg(h);
    const ticketId = await gmailTicket();
    const response = await reply(agent, ticketId, 'Staff reply');
    const deliveryId = deliveryOf(response).id;
    await grant('client', 'ticket.reply');
    await grant('client', 'ticket.cancel.any');
    try {
      const denied = await cancel(mine.persona, ticketId, deliveryId);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('forbidden');
    } finally {
      await revoke('client', 'ticket.reply');
      await revoke('client', 'ticket.cancel.any');
    }
    const row = await pool().query<{ state: string }>(
      `SELECT state FROM outbound_delivery WHERE id = $1`,
      [deliveryId],
    );
    expect(row.rows[0]?.state).toBe('scheduled');
  });
});

describe('sending an AI draft (N3, A-2)', () => {
  async function draftOn(ticketId: string, body: string): Promise<string> {
    const row = await pool().query<{ id: string }>(
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, $2) RETURNING id`,
      [ticketId, body],
    );
    return row.rows[0]?.id ?? '';
  }

  it('binds the approval to the exact text and to the person who pressed send', async () => {
    const intent = await apiIntent(lead, {
      key: `outbound_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
      name: 'Outbound test',
    });
    const ticketId = await gmailTicket({ intentId: intent.id });
    const draftId = await draftOn(ticketId, 'Please restart the connector.');

    const tampered = await reply(agent, ticketId, 'Please restart the connector!', {
      aiDraftId: draftId,
    });
    expect(tampered.status).toBe(403);
    expect(
      (await messagesOf(agent, ticketId)).filter((m) => m.direction === 'outbound'),
    ).toHaveLength(0);

    const ok = await reply(agent, ticketId, 'Please restart the connector.', {
      aiDraftId: draftId,
    });
    expect(ok.status).toBe(201);
    expect(deliveryOf(ok)).toMatchObject({ origin: 'ai_approved', state: 'scheduled' });
    const stored = await pool().query<{ status: string; approved_by: string }>(
      `SELECT status, approved_by FROM ai_draft WHERE id = $1`,
      [draftId],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'approved', approved_by: agent.userId });

    // Undo returns the draft to waiting; it can be sent again, once.
    expect((await cancel(agent, ticketId, deliveryOf(ok).id)).status).toBe(200);
    const again = await reply(agent, ticketId, 'Please restart the connector.', {
      aiDraftId: draftId,
    });
    expect(again.status).toBe(201);
    const twice = await reply(agent, ticketId, 'Please restart the connector.', {
      aiDraftId: draftId,
    });
    expect(twice.status).toBe(403);
  });

  it('refuses a draft that is not on this ticket, a malformed id, and an unclassified ticket', async () => {
    const intent = await apiIntent(lead, {
      key: `outbound_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
      name: 'Outbound test 2',
    });
    const ticketId = await gmailTicket({ intentId: intent.id });
    const elsewhere = await gmailTicket({ intentId: intent.id });
    const foreign = await draftOn(elsewhere, 'Not yours');
    expect((await reply(agent, ticketId, 'Not yours', { aiDraftId: foreign })).status).toBe(403);
    expect((await reply(agent, ticketId, 'x', { aiDraftId: 'nope' })).status).toBe(400);

    const bare = await gmailTicket();
    const orphan = await draftOn(bare, 'No intent here');
    const denied = await reply(agent, bare, 'No intent here', { aiDraftId: orphan });
    expect(denied.status).toBe(403);
    // The same words typed as a plain reply are still the AI's text and are refused (T-122f N-1);
    // the person's own words are fine.
    const typedAgain = await reply(agent, bare, 'No intent here');
    expect(typedAgain.status).toBe(403);
    expect(JSON.stringify(typedAgain.body)).toContain('text of an AI draft');
    expect((await reply(agent, bare, 'No intent here, as I would put it')).status).toBe(201);
  });
});

describe('the undo-send setting', () => {
  it('is readable by staff, changeable by the head only, 0 to 30 seconds, and takes effect for the next reply', async () => {
    const read = await agent.client.get<OutboundSettings>('/v1/settings/outbound');
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ undoSendSeconds: 5 });

    expect((await lead.client.put('/v1/settings/outbound', { undoSendSeconds: 10 })).status).toBe(
      403,
    );
    expect((await agent.client.put('/v1/settings/outbound', { undoSendSeconds: 10 })).status).toBe(
      403,
    );
    expect((await h.client().get('/v1/settings/outbound')).status).toBe(401);
    for (const bad of [31, -1, 2.5, '5', null]) {
      expect(
        (await head.client.put('/v1/settings/outbound', { undoSendSeconds: bad })).status,
        String(bad),
      ).toBe(400);
    }

    expect(
      (await head.client.put<OutboundSettings>('/v1/settings/outbound', { undoSendSeconds: 0 }))
        .body,
    ).toEqual({
      undoSendSeconds: 0,
    });
    try {
      const instant = await reply(agent, await gmailTicket(), 'No hold');
      expect(deliveryOf(instant)).toMatchObject({ cancellable: false, state: 'scheduled' });
      expect(
        (await cancel(agent, instant.body.message.ticketId, deliveryOf(instant).id)).status,
      ).toBe(409);
    } finally {
      expect((await head.client.put('/v1/settings/outbound', { undoSendSeconds: 5 })).status).toBe(
        200,
      );
    }
    const audit = await pool().query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'outbound.setting_set' AND actor_id = $1`,
      [head.userId],
    );
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });
});
